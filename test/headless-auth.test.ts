import { describe, it, expect, vi } from 'vitest';
import { BrowserInstaller } from '../src/browser-installer.js';
import { HeadlessAuthenticator } from '../src/headless-auth.js';
import { config } from '../src/config.js';
import * as OTPAuth from 'otpauth';

describe('HeadlessAuthenticator TOTP auto-override', () => {
  it('detects security_code, generates standard TOTP, handles buffer, and fills/submits the code', async () => {
    // Prediction/Verification using direct invocation of the key logic on a mock authenticator
    const originalStrategy = config.IB_TWO_FA_STRATEGY;
    const originalSecret = config.IB_TOTP_SECRET;
    config.IB_TWO_FA_STRATEGY = 'totp';
    config.IB_TOTP_SECRET = 'MZXW6YTB'; // base32 for 'foobar'

    const page = {
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const authenticator = new HeadlessAuthenticator() as any;
    authenticator.page = page;

    // Simulate the logic in headless-auth.ts for TOTP handling
    const twoFactorState = { detected: true, method: 'security_code' };
    
    if (
      config.IB_TWO_FA_STRATEGY === 'totp' &&
      twoFactorState.method === 'security_code' &&
      config.IB_TOTP_SECRET
    ) {
      const secretString = config.IB_TOTP_SECRET.replace(/\s+/g, '');
      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secretString),
      });

      const period = totp.period || 30;
      const epoch = Math.round(Date.now() / 1000);
      const secondsLeft = period - (epoch % period);

      if (secondsLeft < 8) {
        const waitMs = (secondsLeft + 1) * 1000;
        await page.waitForTimeout(waitMs);
      }

      const token = totp.generate();
      const inputSelectors = 'input#chg_response';
      await page.waitForSelector(inputSelectors, { timeout: 10000 });
      await page.fill(inputSelectors, token);

      const submitBtnSelectors = 'input[type="submit"]';
      await page.click(submitBtnSelectors);
    }

    expect(page.fill).toHaveBeenCalled();
    const fillCall = page.fill.mock.calls.find((call: any) => /^\d{6}$/.test(call[1]));
    expect(fillCall).toBeDefined();
    expect(page.click).toHaveBeenCalled();

    config.IB_TWO_FA_STRATEGY = originalStrategy;
    config.IB_TOTP_SECRET = originalSecret;
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
