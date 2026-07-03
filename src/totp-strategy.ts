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
  /** Total submissions allowed before the handler reports itself exhausted. */
  maxAttempts?: number;
}

// Selectors matching the security-code form on current IBKR login pages.
// Overridable via IB_SELECTOR_TOTP_INPUT / IB_SELECTOR_TOTP_SUBMIT when IBKR
// changes its markup.
export const DEFAULT_TOTP_INPUT_SELECTOR = [
  'input#chg_response',
  'input[name="chg_response"]',
  'input[name="response"]',
  'input#security_code',
  'input[name="security_code"]',
].join(', ');

export const DEFAULT_TOTP_SUBMIT_SELECTOR = [
  'input[type="submit"]',
  'button[type="submit"]',
  'button#submitForm',
].join(', ');

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
  private readonly maxAttempts: number;
  private attempts = 0;
  private lastAttemptWindow = -1;

  constructor(options: TotpChallengeOptions) {
    this.totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(options.secret.replace(/\s+/g, '')),
    });
    this.inputSelector = options.inputSelector || DEFAULT_TOTP_INPUT_SELECTOR;
    this.submitSelector = options.submitSelector || DEFAULT_TOTP_SUBMIT_SELECTOR;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
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

    const input = page.locator(this.inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill(token);
    await page.locator(this.submitSelector).first().click();
    Logger.info('🚀 Security code filled and submitted.');

    // Give the submission a moment to register before the next status poll.
    await page.waitForTimeout(2000);
    return true;
  }
}
