import { Page } from 'playwright-core';
import * as OTPAuth from 'otpauth';
import { Logger } from './logger.js';

interface TotpChallengeOptions {
  /** Base32 TOTP secret. Whitespace is ignored. */
  secret: string;
  /** CSS selector (list) for the security-code input. Defaults to the known IBKR selectors. */
  inputSelector?: string;
  /** CSS selector (list) for the submit control. Defaults to the known IBKR selectors. */
  submitSelector?: string;
  /** CSS selector for the second-factor-device chooser. Defaults to `select`. */
  deviceSelectSelector?: string;
  /** Total submissions allowed before the handler reports itself exhausted. */
  maxAttempts?: number;
}

// Selectors matching the security-code form on current IBKR login pages.
// Overridable via IB_SELECTOR_TOTP_INPUT / IB_SELECTOR_TOTP_SUBMIT when IBKR
// changes its markup.
//
// The current IBKR "XYZ" login widget renders the authenticator/security-code
// field as #xyz-field-silver-response (placeholder "Mobile Authenticator App
// Code"), with #xyz-field-gold-response / #xyz-field-temp-response used for the
// response-card and temporary-code variants. The older ids are kept as
// fallbacks for other Gateway builds.
export const DEFAULT_TOTP_INPUT_SELECTOR = [
  'input#xyz-field-silver-response',
  'input[name="silver-response"]',
  'input#xyz-field-gold-response',
  'input[name="gold-response"]',
  'input#xyz-field-temp-response',
  'input[name="temp-response"]',
  'input#chg_response',
  'input[name="chg_response"]',
  'input[name="response"]',
  'input#security_code',
  'input[name="security_code"]',
].join(', ');

export const DEFAULT_TOTP_SUBMIT_SELECTOR = [
  'button.xyz-button-login',
  'input[type="submit"]',
  'button[type="submit"]',
  'button#submitForm',
].join(', ');

// When an account has more than one second-factor device enrolled, IBKR first
// shows a native <select> asking which device to use. We must pick the
// authenticator-app option before the security-code field is rendered.
// Overridable via IB_SELECTOR_TOTP_DEVICE_SELECT.
export const DEFAULT_TOTP_DEVICE_SELECT_SELECTOR = 'select';

// Matches the authenticator-app option label in the device chooser
// (e.g. "Mobile Authenticator App").
const AUTHENTICATOR_OPTION_PATTERN = /authenticator/i;

// A code submitted this close to rollover may expire before IBKR validates it.
const MIN_SECONDS_LEFT_IN_WINDOW = 8;

const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Fills and submits TOTP codes for the IBKR security-code challenge.
 *
 * IBKR permanently locks accounts after repeated failed 2FA responses, so the
 * handler enforces two guardrails: it submits at most once per TOTP window
 * (resubmitting within the window would resend an already-rejected code), and
 * at most `maxAttempts` times overall. Once exhausted, the caller should stop
 * the login attempt instead of letting the challenge screen sit in a retry loop.
 */
export class TotpChallengeHandler {
  private readonly totp: OTPAuth.TOTP;
  private readonly inputSelector: string;
  private readonly submitSelector: string;
  private readonly deviceSelectSelector: string;
  private readonly maxAttempts: number;
  private attempts = 0;
  private lastAttemptWindow = -1;

  constructor(options: TotpChallengeOptions) {
    this.totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(options.secret.replace(/\s+/g, '')),
    });
    this.inputSelector = options.inputSelector || DEFAULT_TOTP_INPUT_SELECTOR;
    this.submitSelector = options.submitSelector || DEFAULT_TOTP_SUBMIT_SELECTOR;
    this.deviceSelectSelector = options.deviceSelectSelector || DEFAULT_TOTP_DEVICE_SELECT_SELECTOR;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * When IBKR shows the "Select Second Factor Device" chooser (accounts with
   * more than one enrolled 2FA device), pick the authenticator-app option so
   * the security-code field is rendered. No-op when the chooser is absent
   * (single-device accounts land straight on the code field). Returns true when
   * a selection was made.
   */
  private async selectAuthenticatorDevice(page: Page): Promise<boolean> {
    const select = page.locator(this.deviceSelectSelector).filter({ visible: true }).first();
    if ((await select.count()) === 0) {
      return false;
    }

    const optionLabels = await select.locator('option').allTextContents();
    const authenticatorLabel = optionLabels
      .map((label) => label.trim())
      .find((label) => AUTHENTICATOR_OPTION_PATTERN.test(label));

    if (!authenticatorLabel) {
      return false;
    }

    // Already on the authenticator option (e.g. we selected it on a previous
    // poll); nothing to do.
    const current = (await select.locator('option:checked').first().textContent().catch(() => null))?.trim();
    if (current && AUTHENTICATOR_OPTION_PATTERN.test(current)) {
      return false;
    }

    Logger.info(`🔐 Selecting second-factor device "${authenticatorLabel}"...`);
    await select.selectOption({ label: authenticatorLabel });
    // Let the widget render the security-code field before we look for it.
    await page.waitForTimeout(1000);
    return true;
  }

  get exhausted(): boolean {
    return this.attempts >= this.maxAttempts;
  }

  private currentWindow(): number {
    return Math.floor(Date.now() / 1000 / this.totp.period);
  }

  private secondsLeftInWindow(): number {
    return this.totp.period - (Math.floor(Date.now() / 1000) % this.totp.period);
  }

  /**
   * Attempts one TOTP submission on `page`. Returns true when a code was
   * filled and submitted, false when the attempt was skipped (still in the
   * same window as the previous attempt, or the attempt budget is spent).
   */
  async submitCode(page: Page): Promise<boolean> {
    if (this.exhausted) {
      return false;
    }

    // Multi-device accounts show a device chooser before the code field. This
    // is idempotent and cheap, so run it on every attempt before checking the
    // TOTP window (selecting a device sends nothing to the phone).
    await this.selectAuthenticatorDevice(page);

    const secondsLeft = this.secondsLeftInWindow();
    if (secondsLeft < MIN_SECONDS_LEFT_IN_WINDOW) {
      Logger.info(`⏳ Only ${secondsLeft}s left in the current TOTP window; waiting for the next one...`);
      await page.waitForTimeout((secondsLeft + 1) * 1000);
    }

    if (this.currentWindow() === this.lastAttemptWindow) {
      // The previous code from this window was rejected or is still being
      // processed; wait for a fresh window instead of resending it.
      return false;
    }

    this.lastAttemptWindow = this.currentWindow();
    this.attempts += 1;

    const token = this.totp.generate();
    Logger.info(`🔑 Submitting TOTP security code (attempt ${this.attempts}/${this.maxAttempts})...`);

    // The credentials form leaves hidden response inputs and login buttons in
    // the DOM, so scope to visible elements to avoid filling/clicking a hidden
    // one.
    const input = page.locator(this.inputSelector).filter({ visible: true }).first();
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill(token);
    await page.locator(this.submitSelector).filter({ visible: true }).first().click();
    Logger.info('🚀 Security code filled and submitted.');

    // Give the submission a moment to register before the next status poll.
    await page.waitForTimeout(2000);
    return true;
  }
}
