import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserInstaller } from '../src/browser-installer.js';
import { HeadlessAuthenticator } from '../src/headless-auth.js';
import * as OTPAuth from 'otpauth';
import {
  TotpChallengeHandler,
  DEFAULT_TOTP_INPUT_SELECTOR,
  DEFAULT_TOTP_SUBMIT_SELECTOR,
  DEFAULT_TOTP_DEVICE_SELECT_SELECTOR,
} from '../src/totp-strategy.js';

const TEST_SECRET = 'MZXW6YTB'; // base32 for 'foobar'

// Epoch chosen so 25s remain in the 30s TOTP window (no pre-submit wait).
const MID_WINDOW_MS = 999_999_995_000;
// Epoch chosen so only 2s remain in the window (forces a wait for the next one).
const WINDOW_EDGE_MS = 1_000_000_018_000;

function expectedTokenAt(timestampMs: number): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(TEST_SECRET),
  }).generate({ timestamp: timestampMs });
}

function createMockPage() {
  const elements = new Map<string, any>();
  const makeLocator = (selector: string): any => {
    if (!elements.has(selector)) {
      // A single object per selector doubles as both the element (waitFor/fill/
      // click) and the chainable locator (filter/first/count/...).
      const locator: any = {
        waitFor: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
        // `.filter({ visible: true })` and `.first()` are chainable no-ops.
        filter: vi.fn(() => locator),
        first: () => locator,
        // No device chooser is present in the unit-test DOM, so the `select`
        // locator reports zero matches and device selection is skipped.
        count: vi.fn(async () => (selector === 'select' ? 0 : 1)),
        locator: vi.fn(() => makeLocator(`${selector} option`)),
        allTextContents: vi.fn(async () => []),
        textContent: vi.fn(async () => null),
        selectOption: vi.fn().mockResolvedValue(undefined),
      };
      elements.set(selector, locator);
    }
    return elements.get(selector);
  };
  const page = {
    locator: vi.fn((selector: string) => makeLocator(selector)),
    // Advance the fake clock so window arithmetic behaves like real time.
    waitForTimeout: vi.fn(async (ms: number) => {
      vi.advanceTimersByTime(ms);
    }),
  };
  return { page: page as any, elements };
}

describe('TotpChallengeHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MID_WINDOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills the security-code input with the exact TOTP and submits it', async () => {
    const { page, elements } = createMockPage();
    const handler = new TotpChallengeHandler({ secret: TEST_SECRET });
    const token = expectedTokenAt(MID_WINDOW_MS);

    await expect(handler.submitCode(page)).resolves.toBe(true);

    const input = elements.get(DEFAULT_TOTP_INPUT_SELECTOR);
    expect(input.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 10000 });
    expect(input.fill).toHaveBeenCalledWith(token);
    expect(elements.get(DEFAULT_TOTP_SUBMIT_SELECTOR).click).toHaveBeenCalledTimes(1);
  });

  it('waits for the next window instead of submitting a code that is about to expire', async () => {
    vi.setSystemTime(new Date(WINDOW_EDGE_MS));
    const { page, elements } = createMockPage();
    const handler = new TotpChallengeHandler({ secret: TEST_SECRET });

    await expect(handler.submitCode(page)).resolves.toBe(true);

    // 2s were left, so the handler waits (2 + 1)s into the next window and
    // generates the token for that window.
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000);
    expect(elements.get(DEFAULT_TOTP_INPUT_SELECTOR).fill).toHaveBeenCalledWith(
      expectedTokenAt(WINDOW_EDGE_MS + 3000),
    );
  });

  it('does not resubmit within the same TOTP window', async () => {
    const { page, elements } = createMockPage();
    const handler = new TotpChallengeHandler({ secret: TEST_SECRET });

    await expect(handler.submitCode(page)).resolves.toBe(true);
    await expect(handler.submitCode(page)).resolves.toBe(false);

    expect(elements.get(DEFAULT_TOTP_INPUT_SELECTOR).fill).toHaveBeenCalledTimes(1);
  });

  it('stops submitting once the attempt budget is spent', async () => {
    const { page, elements } = createMockPage();
    const handler = new TotpChallengeHandler({ secret: TEST_SECRET, maxAttempts: 2 });

    await expect(handler.submitCode(page)).resolves.toBe(true);
    expect(handler.exhausted).toBe(false);

    vi.advanceTimersByTime(30_000); // move to the next TOTP window
    await expect(handler.submitCode(page)).resolves.toBe(true);
    expect(handler.exhausted).toBe(true);

    vi.advanceTimersByTime(30_000);
    await expect(handler.submitCode(page)).resolves.toBe(false);
    expect(elements.get(DEFAULT_TOTP_INPUT_SELECTOR).fill).toHaveBeenCalledTimes(2);
  });

  it('accepts base32 secrets containing spaces', async () => {
    const { page, elements } = createMockPage();
    const handler = new TotpChallengeHandler({ secret: 'MZXW 6YTB' });

    await expect(handler.submitCode(page)).resolves.toBe(true);

    expect(elements.get(DEFAULT_TOTP_INPUT_SELECTOR).fill).toHaveBeenCalledWith(
      expectedTokenAt(MID_WINDOW_MS),
    );
  });

  it('selects the authenticator device before filling the code when a chooser is shown', async () => {
    const elements = new Map<string, any>();
    const selectMock = {
      filter: vi.fn(() => selectMock),
      first: () => selectMock,
      count: vi.fn(async () => 1),
      selectOption: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((sub: string) => ({
        allTextContents: vi.fn(async () => ['Select Type', 'IB Key', 'Mobile Authenticator App']),
        first: () => ({ textContent: vi.fn(async () => (sub === 'option:checked' ? 'Select Type' : null)) }),
      })),
    };
    const makeEl = () => ({
      waitFor: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    });
    const page: any = {
      locator: vi.fn((selector: string) => {
        if (selector === DEFAULT_TOTP_DEVICE_SELECT_SELECTOR) return selectMock;
        if (!elements.has(selector)) {
          const el = makeEl();
          elements.set(selector, { filter: vi.fn(() => ({ first: () => el })), first: () => el, _el: el });
        }
        return elements.get(selector);
      }),
      waitForTimeout: vi.fn(async (ms: number) => vi.advanceTimersByTime(ms)),
    };

    const handler = new TotpChallengeHandler({ secret: TEST_SECRET });
    await expect(handler.submitCode(page)).resolves.toBe(true);

    expect(selectMock.selectOption).toHaveBeenCalledWith({ label: 'Mobile Authenticator App' });
    expect(elements.get(DEFAULT_TOTP_INPUT_SELECTOR)._el.fill).toHaveBeenCalledWith(
      expectedTokenAt(MID_WINDOW_MS),
    );
    expect(elements.get(DEFAULT_TOTP_SUBMIT_SELECTOR)._el.click).toHaveBeenCalledTimes(1);
  });

  it('honors selector overrides for the input and submit controls', async () => {
    const { page, elements } = createMockPage();
    const handler = new TotpChallengeHandler({
      secret: TEST_SECRET,
      inputSelector: '#custom-code-input',
      submitSelector: '#custom-submit',
    });

    await expect(handler.submitCode(page)).resolves.toBe(true);

    expect(elements.get('#custom-code-input').fill).toHaveBeenCalledTimes(1);
    expect(elements.get('#custom-submit').click).toHaveBeenCalledTimes(1);
  });
});

describe('HeadlessAuthenticator state detection', () => {
  it('marks security-code 2FA as waiting for user action without claiming push delivery', async () => {
    const authenticator = new HeadlessAuthenticator() as any;
    authenticator.page = {
      evaluate: vi.fn().mockResolvedValue({
        visibleText: 'Enter temporary security code',
        visibleButtons: 'Submit',
      }),
    };

    const state = await authenticator.detectTwoFactorState();
    const result = authenticator.buildWaitingFor2FAResult(state, 60_000);

    expect(state).toMatchObject({
      detected: true,
      method: 'security_code',
    });
    expect(result).toMatchObject({
      success: false,
      status: 'WAITING_FOR_USER_2FA',
      waitingFor2FA: true,
      pushDelivered: false,
      browserKeptOpen: true,
    });
  });

  it('only marks push delivery when the page explicitly says a notification was sent', async () => {
    const authenticator = new HeadlessAuthenticator() as any;
    authenticator.page = {
      evaluate: vi.fn().mockResolvedValue({
        visibleText: 'We sent you a notification. Open the IBKR notification to continue.',
        visibleButtons: 'Resend notification',
      }),
    };

    const state = await authenticator.detectTwoFactorState();
    const result = authenticator.buildWaitingFor2FAResult(state, 60_000);

    expect(state).toMatchObject({
      detected: true,
      method: 'ibkr_mobile_push',
    });
    expect(result.pushDelivered).toBe(true);
  });

  it('detects credential/authentication failures separately from 2FA waits', async () => {
    const authenticator = new HeadlessAuthenticator() as any;
    authenticator.page = {
      evaluate: vi.fn().mockResolvedValue({
        visibleText: 'Login failed. Invalid username or password.',
        visibleAlerts: 'Invalid username or password.',
      }),
    };

    const state = await authenticator.detectAuthenticationFailureState();

    expect(state).toMatchObject({
      detected: true,
    });
    expect(state.message).toContain('invalid username');
  });
});

describe('HeadlessAuthenticator authenticate', () => {
  it('initializes the brokerage session before waiting for the browser success message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const cookies = [{ name: 'SBID', value: 'abc', domain: 'localhost' }];
    const page = {
      setDefaultTimeout: vi.fn(),
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      url: vi.fn(() => 'https://localhost:5000/sso/pending'),
      content: vi.fn().mockResolvedValue('<html>Waiting for mobile approval</html>'),
      context: vi.fn(() => ({ cookies: vi.fn().mockResolvedValue(cookies) })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launchSpy = vi
      .spyOn(BrowserInstaller, 'launchLocalBrowser')
      .mockResolvedValue(browser as any);
    const ibClient = {
      checkAuthenticationStatus: vi.fn().mockResolvedValue(false),
      setSessionCookies: vi.fn(),
      initializeBrokerageSession: vi.fn().mockResolvedValue(true),
    };

    try {
      const authenticator = new HeadlessAuthenticator();
      const authPromise = authenticator.authenticate({
        url: 'https://localhost:5000',
        username: 'user',
        password: 'pass',
        timeout: 10_000,
        ibClient: ibClient as any,
      });

      await vi.advanceTimersByTimeAsync(3000);
      const result = await authPromise;

      expect(ibClient.checkAuthenticationStatus).toHaveBeenCalled();
      expect(ibClient.setSessionCookies).toHaveBeenCalledWith(cookies);
      expect(ibClient.initializeBrokerageSession).toHaveBeenCalledTimes(1);
      expect(page.content).toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        status: 'SUCCESS',
      });
      expect(result.message).toContain('Brokerage session initialized after SSO/mobile approval');
    } finally {
      launchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
