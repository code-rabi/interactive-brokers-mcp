import { describe, it, expect, vi } from 'vitest';
import { HeadlessAuthenticator } from '../src/headless-auth.js';

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
