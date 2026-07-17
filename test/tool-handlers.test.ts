// test/tool-handlers.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ToolHandlers, ToolHandlerContext } from '../src/tool-handlers.js';
import { IBClient } from '../src/ib-client.js';
import { IBGatewayManager } from '../src/gateway-manager.js';
import { HeadlessAuthenticator } from '../src/headless-auth.js';
import { OrderIdempotencyStore } from '../src/order-idempotency-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import open from 'open';

// Mock dependencies
vi.mock('../src/ib-client.js');
vi.mock('../src/gateway-manager.js');
vi.mock('../src/headless-auth.js');
vi.mock('open', () => ({ default: vi.fn() }));

describe('ToolHandlers', () => {
  let handlers: ToolHandlers;
  let mockIBClient: IBClient;
  let mockGatewayManager: IBGatewayManager;
  let context: ToolHandlerContext;
  let orderStoreDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    orderStoreDir = await mkdtemp(path.join(tmpdir(), 'ib-mcp-handler-orders-'));
  vi.mocked(HeadlessAuthenticator).mockImplementation(function MockHeadlessAuthenticator() {
    return {
      authenticate: vi.fn().mockResolvedValue({ success: true }),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

    // Create mock IBClient
    mockIBClient = {
      checkAuthenticationStatus: vi.fn().mockResolvedValue(true),
      reauthenticate: vi.fn().mockResolvedValue(undefined),
      getAccountInfo: vi.fn().mockResolvedValue({ accounts: [] }),
      getPositions: vi.fn().mockResolvedValue([]),
      getMarketData: vi.fn().mockResolvedValue({ price: 150 }),
      placeOrder: vi.fn().mockResolvedValue({ orderId: '123' }),
      prepareOrder: vi.fn().mockImplementation(async (order) => ({ accountId: order.accountId, order: { conid: order.conid ?? 265598 } })),
      submitPreparedOrder: vi.fn().mockResolvedValue({ orderId: '123' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'Filled' }),
      getOrders: vi.fn().mockResolvedValue([]),
      confirmOrder: vi.fn().mockResolvedValue({ confirmed: true }),
      destroy: vi.fn(),
      updatePort: vi.fn(),
      getAlerts: vi.fn().mockResolvedValue([]),
      createAlert: vi.fn().mockResolvedValue({ request_id: '1' }),
      activateAlert: vi.fn().mockResolvedValue({ success: true }),
      deleteAlert: vi.fn().mockResolvedValue({ success: true }),
    } as any;

    // Create mock GatewayManager
    mockGatewayManager = {
      ensureGatewayReady: vi.fn().mockResolvedValue(undefined),
      getCurrentPort: vi.fn().mockReturnValue(5000),
      start: vi.fn(),
      stop: vi.fn(),
    } as any;

    // Create context
    context = {
      ibClient: mockIBClient,
      gatewayManager: mockGatewayManager,
      config: {
        IB_HEADLESS_MODE: false,
        IB_GATEWAY_HOST: 'localhost',
        IB_GATEWAY_PORT: 5000,
        IB_AUTH_TIMEOUT: 10, // Use a short timeout for testing
        IB_READ_ONLY_MODE: false,
        IB_ALLOWED_ACCOUNT_ID: 'U12345',
      },
      orderIdempotencyStore: new OrderIdempotencyStore(path.join(orderStoreDir, 'orders.json')),
    };

    handlers = new ToolHandlers(context);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(orderStoreDir, { recursive: true, force: true });
  });


  describe('getAccountInfo', () => {
    it('should return account information', async () => {
      const mockAccounts = [{ id: 'U12345', accountId: 'U12345' }];
      mockIBClient.getAccountInfo = vi.fn().mockResolvedValue({ accounts: mockAccounts });

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(mockGatewayManager.ensureGatewayReady).toHaveBeenCalled();
      expect(mockIBClient.getAccountInfo).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue(new Error('API Error'));

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('API Error');
    });
  });

  describe('getPositions', () => {
    it('should return positions for account', async () => {
      const mockPositions = [{ symbol: 'AAPL', position: 10 }];
      mockIBClient.getPositions = vi.fn().mockResolvedValue(mockPositions);

      const result = await handlers.getPositions({ accountId: 'U12345' });

      expect(result.content).toBeDefined();
      expect(mockIBClient.getPositions).toHaveBeenCalledWith('U12345');
    });

    it('should handle missing accountId', async () => {
      const result = await handlers.getPositions({} as any);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Account ID is required');
    });
  });

  describe('getMarketData', () => {
    it('should return market data for symbol', async () => {
      const mockData = { symbol: 'AAPL', price: 150.25 };
      mockIBClient.getMarketData = vi.fn().mockResolvedValue(mockData);

      const result = await handlers.getMarketData({ symbol: 'AAPL' });

      expect(result.content).toBeDefined();
      expect(mockIBClient.getMarketData).toHaveBeenCalledWith('AAPL', undefined);
    });

    it('should pass exchange parameter', async () => {
      const mockData = { symbol: 'AAPL', price: 150.25 };
      mockIBClient.getMarketData = vi.fn().mockResolvedValue(mockData);

      await handlers.getMarketData({ symbol: 'AAPL', exchange: 'NASDAQ' });

      expect(mockIBClient.getMarketData).toHaveBeenCalledWith('AAPL', 'NASDAQ');
    });
  });

  describe('placeOrder', () => {
    const validOrder = {
      clientOrderId: 'codex-20260716-001',
      accountId: 'U12345',
      symbol: 'AAPL',
      action: 'BUY' as const,
      orderType: 'LMT' as const,
      quantity: 10,
      price: 150.50,
    };

    it('should map an allowed limit stock order', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.submitPreparedOrder = vi.fn().mockResolvedValue(mockResponse);

      const result = await handlers.placeOrder(validOrder);

      expect(result.content).toBeDefined();
      expect(mockIBClient.prepareOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          clientOrderId: 'codex-20260716-001',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 10,
          price: 150.50,
        })
      );
      expect(mockIBClient.submitPreparedOrder).toHaveBeenCalledTimes(1);
    });

    it('should reject account mismatch before calling the IB client', async () => {
      const result = await handlers.placeOrder({ ...validOrder, accountId: 'U99999' });

      expect(result.content[0].text).toContain('U12345');
      expect(mockIBClient.placeOrder).not.toHaveBeenCalled();
    });

    it('should reject unsafe direct calls that bypass schema validation', async () => {
      const result = await handlers.placeOrder({ ...validOrder, orderType: 'MKT' } as any);

      expect(result.content[0].text).toMatch(/LMT|limit/i);
      expect(mockIBClient.placeOrder).not.toHaveBeenCalled();
    });

    it('should handle order placement errors', async () => {
      mockIBClient.submitPreparedOrder = vi.fn().mockRejectedValue(new Error('Order failed'));

      const result = await handlers.placeOrder(validOrder);

      expect(result.content[0].text).toContain('Order failed');
    });

    it('should replay a completed result after handler restart without submitting again', async () => {
      const response = [{ id: 'order-123', status: 'Submitted' }];
      mockIBClient.submitPreparedOrder = vi.fn().mockResolvedValue(response);
      const first = await handlers.placeOrder(validOrder);

      const restarted = new ToolHandlers({
        ...context,
        orderIdempotencyStore: new OrderIdempotencyStore(path.join(orderStoreDir, 'orders.json')),
      });
      const replay = await restarted.placeOrder({ ...validOrder });

      expect(JSON.parse(first.content[0].text)).toEqual(response);
      expect(JSON.parse(replay.content[0].text)).toEqual(response);
      expect(mockIBClient.submitPreparedOrder).toHaveBeenCalledTimes(1);
    });

    it('should persist transport timeouts as SUBMISSION_UNCERTAIN and never auto-retry', async () => {
      const transportError = Object.assign(new Error('request timed out'), {
        name: 'OrderSubmissionError',
        transportCode: 'UND_ERR_CONNECT_TIMEOUT',
        submissionUncertain: true,
      });
      mockIBClient.submitPreparedOrder = vi.fn().mockRejectedValue(transportError);

      const first = await handlers.placeOrder(validOrder);
      const second = await handlers.placeOrder({ ...validOrder });
      const firstPayload = JSON.parse(first.content[0].text);
      const secondPayload = JSON.parse(second.content[0].text);

      expect(firstPayload).toMatchObject({
        code: 'SUBMISSION_UNCERTAIN',
        submissionUncertain: true,
        transportCode: 'UND_ERR_CONNECT_TIMEOUT',
      });
      expect(secondPayload).toMatchObject({
        code: 'SUBMISSION_UNCERTAIN',
        submissionUncertain: true,
        persistedRecord: { state: 'uncertain', error: { submissionUncertain: true } },
      });
      expect(mockIBClient.submitPreparedOrder).toHaveBeenCalledTimes(1);
    });

    it('does not reserve the client order ID when contract preflight fails', async () => {
      mockIBClient.prepareOrder = vi.fn().mockRejectedValue(new Error('contract preflight failed'));

      const result = await handlers.placeOrder(validOrder);

      expect(result.content[0].text).toContain('contract preflight failed');
      expect(await context.orderIdempotencyStore!.get(validOrder.clientOrderId)).toBeUndefined();
      expect(mockIBClient.submitPreparedOrder).not.toHaveBeenCalled();
    });

    it('replays a persisted reserved record as explicit SUBMISSION_UNCERTAIN after restart', async () => {
      await context.orderIdempotencyStore!.reserve(validOrder);
      const restarted = new ToolHandlers(context);

      const result = await restarted.placeOrder(validOrder);
      const payload = JSON.parse(result.content[0].text);

      expect(payload).toMatchObject({ code: 'SUBMISSION_UNCERTAIN', submissionUncertain: true });
      expect(payload.message).toMatch(/manual|manually|人工|IBKR/i);
      expect(mockIBClient.prepareOrder).not.toHaveBeenCalled();
      expect(mockIBClient.submitPreparedOrder).not.toHaveBeenCalled();
    });

    it('reports SUBMISSION_UNCERTAIN when the POST succeeds but terminal persistence fails', async () => {
      mockIBClient.prepareOrder = vi.fn().mockResolvedValue({ accountId: validOrder.accountId, order: { conid: 265598 } });
      mockIBClient.submitPreparedOrder = vi.fn().mockResolvedValue({ orderId: 'accepted-before-crash' });
      const store = context.orderIdempotencyStore!;
      store.recordResponse = vi.fn().mockRejectedValue(new Error('disk failed after POST'));

      const first = await handlers.placeOrder(validOrder);
      const replay = await new ToolHandlers(context).placeOrder(validOrder);

      expect(JSON.parse(first.content[0].text)).toMatchObject({
        code: 'SUBMISSION_UNCERTAIN',
        submissionUncertain: true,
        brokerResponse: { orderId: 'accepted-before-crash' },
        persistenceError: { message: 'disk failed after POST' },
      });
      expect(JSON.parse(replay.content[0].text)).toMatchObject({
        code: 'SUBMISSION_UNCERTAIN',
        submissionUncertain: true,
        persistedRecord: {
          error: { brokerResponse: { orderId: 'accepted-before-crash' } },
        },
      });
      expect(mockIBClient.submitPreparedOrder).toHaveBeenCalledTimes(1);
    });

    it('returns exact broker response when both terminal and fallback persistence fail', async () => {
      mockIBClient.submitPreparedOrder = vi.fn().mockResolvedValue({ orderId: 'accepted-before-double-failure' });
      const store = context.orderIdempotencyStore!;
      store.recordResponse = vi.fn().mockRejectedValue(new Error('terminal persistence failed'));
      store.recordUncertain = vi.fn().mockRejectedValue(new Error('fallback persistence failed'));

      const first = await handlers.placeOrder(validOrder);
      const replay = await new ToolHandlers(context).placeOrder(validOrder);

      expect(JSON.parse(first.content[0].text)).toMatchObject({
        code: 'SUBMISSION_UNCERTAIN',
        submissionUncertain: true,
        brokerResponse: { orderId: 'accepted-before-double-failure' },
        persistenceError: { message: 'terminal persistence failed' },
      });
      expect(JSON.parse(replay.content[0].text)).toMatchObject({
        code: 'SUBMISSION_UNCERTAIN',
        persistedRecord: { state: 'reserved' },
      });
      expect(mockIBClient.submitPreparedOrder).toHaveBeenCalledTimes(1);
    });

    it.each([
      { submissionUncertain: true, persistenceMethod: 'recordUncertain' as const },
      { submissionUncertain: false, persistenceMethod: 'recordResponse' as const },
    ])('does not replace a structured submission response when $persistenceMethod fails', async ({ submissionUncertain, persistenceMethod }) => {
      const structured = Object.assign(new Error('structured broker outcome'), {
        name: 'OrderSubmissionError',
        status: 400,
        ibkrBody: { errorCode: 201, error: 'Order rejected' },
        submissionUncertain,
      });
      mockIBClient.submitPreparedOrder = vi.fn().mockRejectedValue(structured);
      context.orderIdempotencyStore![persistenceMethod] = vi.fn().mockRejectedValue(new Error('persistence unavailable'));

      const result = await handlers.placeOrder(validOrder);

      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: submissionUncertain ? 'SUBMISSION_UNCERTAIN' : 'ORDER_SUBMISSION_FAILED',
        message: 'structured broker outcome',
        status: 400,
        ibkrBody: { errorCode: 201, error: 'Order rejected' },
        submissionUncertain,
      });
    });
  });

  describe('getLiveOrders', () => {
    it('should return all live orders', async () => {
      const mockOrders = [{ orderId: '123', status: 'Working' }];
      mockIBClient.getOrders = vi.fn().mockResolvedValue(mockOrders);

      const result = await handlers.getLiveOrders({});

      expect(result.content).toBeDefined();
      expect(mockIBClient.getOrders).toHaveBeenCalledWith(undefined);
    });

    it('should always fetch all orders without account parameter', async () => {
      const mockOrders = [{ orderId: '123', status: 'Working' }];
      mockIBClient.getOrders = vi.fn().mockResolvedValue(mockOrders);

      const result = await handlers.getLiveOrders({});

      expect(mockIBClient.getOrders).toHaveBeenCalledWith(undefined);
      expect(result.content).toBeDefined();
    });
  });

  describe('getOrderStatus', () => {
    it('should return order status', async () => {
      const mockStatus = { orderId: '123', status: 'Filled' };
      mockIBClient.getOrderStatus = vi.fn().mockResolvedValue(mockStatus);

      const result = await handlers.getOrderStatus({ orderId: '123' });

      expect(result.content).toBeDefined();
      expect(mockIBClient.getOrderStatus).toHaveBeenCalledWith('123');
    });
  });

  describe('confirmOrder', () => {
    it('should confirm order', async () => {
      const mockResponse = { confirmed: true };
      mockIBClient.confirmOrder = vi.fn().mockResolvedValue(mockResponse);

      const result = await handlers.confirmOrder({
        replyId: 'reply-123',
        messageIds: ['msg1', 'msg2'],
      });

      expect(result.content).toBeDefined();
      expect(mockIBClient.confirmOrder).toHaveBeenCalledWith('reply-123', ['msg1', 'msg2']);
    });
  });

  describe('authenticate', () => {
    it('should open browser and return polling response in browser mode', async () => {
      context.config.IB_HEADLESS_MODE = false;
      vi.mocked(open).mockResolvedValueOnce(undefined as any);

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.mode).toBe('browser');
      expect(response.browserOpened).toBe(true);
      expect(response.polling).toBe(true);
      expect(response.authUrl).toContain('localhost:5000');
      expect(vi.mocked(open)).toHaveBeenCalledWith(response.authUrl);
    });

    it('should return manual instructions when browser fails to open', async () => {
      context.config.IB_HEADLESS_MODE = false;
      vi.mocked(open).mockRejectedValueOnce(new Error('No browser available'));

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.mode).toBe('manual');
      expect(response.browserOpened).toBe(false);
      expect(response.instructions).toBeDefined();
      expect(response.instructions.length).toBeGreaterThan(0);
    });

    it('should return full response with instructions in browser mode', async () => {
      context.config.IB_HEADLESS_MODE = false;
      vi.mocked(open).mockResolvedValueOnce(undefined as any);

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.mode).toBe('browser');
      expect(response.browserOpened).toBe(true);
      expect(response.polling).toBe(true);
      expect(response.message).toContain('authentication interface opened');
      expect(response.note).toContain('Polling for authentication completion');
      expect(response.instructions).toHaveLength(5);
      expect(response.instructions[0]).toContain('opened in your default browser');
    });

    it('should return missing credentials error in headless mode', async () => {
      context.config.IB_HEADLESS_MODE = true;
      context.config.IB_USERNAME = '';
      context.config.IB_PASSWORD_AUTH = '';

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('IB_USERNAME');
    });

    it('should handle non-Error thrown by open', async () => {
      context.config.IB_HEADLESS_MODE = false;
      vi.mocked(open).mockRejectedValueOnce('spawn ENOENT');

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.mode).toBe('manual');
      expect(response.browserOpened).toBe(false);
    });
  });

  describe('Headless Mode Authentication', () => {
    beforeEach(() => {
      context.config.IB_HEADLESS_MODE = true;
      context.config.IB_USERNAME = 'testuser';
      context.config.IB_PASSWORD_AUTH = 'testpass';
      handlers = new ToolHandlers(context);
    });

    it('should return account info directly if already authenticated', async () => {
      const mockAccounts = [{ id: 'U12345' }];
      mockIBClient.checkAuthenticationStatus = vi.fn().mockResolvedValue(true);
      mockIBClient.getAccountInfo = vi.fn().mockResolvedValue({ accounts: mockAccounts });

      const result = await handlers.getAccountInfo({ confirm: true });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.accounts).toEqual(mockAccounts);
      expect(mockIBClient.getAccountInfo).toHaveBeenCalled();
      expect(HeadlessAuthenticator).not.toHaveBeenCalled();
    });

    it('should recover an expired session via reauthenticate without a browser or 2FA', async () => {
      const mockAccounts = [{ id: 'U12345' }];
      mockIBClient.getAccountInfo = vi.fn().mockResolvedValue({ accounts: mockAccounts });
      mockIBClient.reauthenticate = vi.fn();

      // The brokerage session is dead but SSO is still valid, so reauthenticate revives it.
      vi.mocked(mockIBClient.checkAuthenticationStatus)
        .mockResolvedValueOnce(false) // ensureAuth's initial check
        .mockResolvedValueOnce(true);  // after reauthenticate

      const result = await handlers.getAccountInfo({ confirm: true });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.accounts).toEqual(mockAccounts);
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
      // The whole point: no headless login, so no TOTP and no IBKR login rate limit.
      expect(HeadlessAuthenticator).not.toHaveBeenCalled();
    });

    it('should open the circuit breaker after repeated login failures', async () => {
      vi.useFakeTimers();
      vi.mocked(mockIBClient.checkAuthenticationStatus).mockResolvedValue(false);
      mockIBClient.reauthenticate = vi.fn();

      for (let i = 0; i < 5; i++) {
        const attempt = (handlers as any).ensureAuth();
        attempt.catch(() => {}); // avoid an unhandled rejection while we advance timers
        await vi.advanceTimersByTimeAsync(11 * 1000);
        await expect(attempt).rejects.toThrow(/Authentication timed out/);
      }

      // The sixth attempt must refuse to touch IBKR again rather than risk a lockout.
      const guarded = await (handlers as any).ensureAuth();
      expect(guarded.ok).toBe(false);
      expect(JSON.parse(guarded.result.content[0].text).status).toBe('AUTHENTICATION_CIRCUIT_OPEN');
      expect(HeadlessAuthenticator).toHaveBeenCalledTimes(5);
    });

    it('should block, authenticate, and then return account info', async () => {
      vi.useFakeTimers();
      const mockAccounts = [{ id: 'U12345' }];
      mockIBClient.getAccountInfo = vi.fn().mockResolvedValue({ accounts: mockAccounts });

      // Simulate being unauthenticated initially, then authenticated after a delay
      vi.mocked(mockIBClient.checkAuthenticationStatus)
        .mockResolvedValueOnce(false) // First call in ensureAuth
        .mockResolvedValueOnce(false) // First poll
        .mockResolvedValueOnce(true);  // Second poll succeeds

      const getAccountInfoPromise = handlers.getAccountInfo({ confirm: true });

      // Let the event loop run to start the async operations
      await vi.advanceTimersByTimeAsync(1);
      
      expect(HeadlessAuthenticator).toHaveBeenCalled();
      
      // Advance time to simulate polling
      await vi.advanceTimersByTimeAsync(5000);
      
      // Advance time again for the successful poll
      await vi.advanceTimersByTimeAsync(5000);

      const result = await getAccountInfoPromise;
      const payload = JSON.parse(result.content[0].text);

      expect(payload.accounts).toEqual(mockAccounts);
      expect(mockIBClient.getAccountInfo).toHaveBeenCalled();
      expect(vi.mocked(mockIBClient.checkAuthenticationStatus)).toHaveBeenCalledTimes(3);
    });
    
    it('should throw a timeout error if authentication does not succeed', async () => {
      vi.useFakeTimers();
      
      // Always return unauthenticated
      vi.mocked(mockIBClient.checkAuthenticationStatus).mockResolvedValue(false);
      
      const getAccountInfoPromise = handlers.getAccountInfo({ confirm: true });

      // Prevent unhandled rejection warning by attaching a catch handler
      getAccountInfoPromise.catch(() => {});
      
      // Let the event loop run to start the async operations
      await vi.advanceTimersByTimeAsync(1);
      
      expect(HeadlessAuthenticator).toHaveBeenCalledTimes(1);
      
      // Advance timers past the timeout
      await vi.advanceTimersByTimeAsync(11 * 1000);
      
      await expect(getAccountInfoPromise).rejects.toThrow(/Authentication timed out/);
      expect(mockIBClient.getAccountInfo).not.toHaveBeenCalled();
    });
  });

  describe('ensureAuth — browser mode', () => {
    beforeEach(() => {
      context.config.IB_HEADLESS_MODE = false;
    });

    it('should return early when already authenticated', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn().mockResolvedValue(true);
      mockIBClient.reauthenticate = vi.fn();

      await (handlers as any).ensureAuth();

      expect(mockIBClient.reauthenticate).not.toHaveBeenCalled();
    });

    it('should attempt reauthenticate before giving up, and throw when it does not help', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      mockIBClient.reauthenticate = vi.fn();

      await expect((handlers as any).ensureAuth())
        .rejects.toThrow('Authentication required');
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });

    it('should recover via reauthenticate without forcing a manual browser login', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockIBClient.reauthenticate = vi.fn();

      await expect((handlers as any).ensureAuth()).resolves.toEqual({ ok: true });
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });
  });

  describe('startBrowserAuthPolling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should poll and call reauthenticate when auth detected', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockIBClient.reauthenticate = vi.fn().mockResolvedValue(undefined);

      (handlers as any).startBrowserAuthPolling('https://localhost:5000', 5000);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockIBClient.checkAuthenticationStatus).toHaveBeenCalledTimes(2);
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAlerts', () => {
    it('should return alerts for account', async () => {
      const mockAlerts = [{ alertId: '1', alertName: 'Price Alert' }];
      mockIBClient.getAlerts = vi.fn().mockResolvedValue(mockAlerts);

      const result = await handlers.getAlerts({ accountId: 'U12345' });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(mockGatewayManager.ensureGatewayReady).toHaveBeenCalled();
      expect(mockIBClient.getAlerts).toHaveBeenCalledWith('U12345');
    });
  });

  describe('Error Handling', () => {
    it('should format authentication errors', async () => {
      const authError = new Error('Authentication required');
      (authError as any).isAuthError = true;
      
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue(authError);

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content[0].text).toContain('Authentication required');
    });

    it('should format generic errors', async () => {
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue(new Error('Generic error'));

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content[0].text).toContain('Generic error');
    });

    it('should handle non-Error objects', async () => {
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue('String error');

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('String error');
    });
  });

  describe('Flex Query Tools', () => {
    describe('getFlexQuery', () => {
      it('should return error when flex query client is not configured', async () => {
        // Context without flex query client (using the one from beforeEach which has no flex client)
        const result = await handlers.getFlexQuery({
          queryId: '123456',  
          parseXml: false,  
        });

        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBe('Flex Query feature not configured');
        expect(response.message).toContain('IB_FLEX_TOKEN');
      });
    });

    describe('listFlexQueries', () => {
      it('should return error when not configured', async () => {
        const result = await handlers.listFlexQueries({ confirm: true });

        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBe('Flex Query feature not configured');
      });
    });

    describe('forgetFlexQuery', () => {
      it('should return error when not configured', async () => {
        const result = await handlers.forgetFlexQuery({ queryId: '123456' });

        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBe('Flex Query feature not configured');
      });
    });
  });

  describe('Option tools', () => {
    it('should return option chain data', async () => {
      const mockChain = {
        symbol: 'AAPL',
        underlyingConid: 265598,
        expirations: [{ expiry: 'JAN27', call: [200], put: [200] }],
      };
      mockIBClient.getOptionChain = vi.fn().mockResolvedValue(mockChain);

      const result = await handlers.getOptionChain({ symbol: 'AAPL', exchange: 'SMART' });

      expect(mockIBClient.getOptionChain).toHaveBeenCalledWith('AAPL', 'SMART');
      expect(result.content[0].text).toContain('"underlyingConid": 265598');
    });

    it('should resolve option conids', async () => {
      const mockResolution = {
        symbol: 'AAPL',
        underlyingConid: 265598,
        option: { conid: 912345678, right: 'C', strike: 200 },
      };
      mockIBClient.resolveOptionConid = vi.fn().mockResolvedValue(mockResolution);

      const result = await handlers.resolveOptionConid({
        symbol: 'AAPL',
        expiry: 'JAN27',
        strike: 200,
        right: 'C',
        exchange: 'SMART',
      });

      expect(mockIBClient.resolveOptionConid).toHaveBeenCalledWith(
        'AAPL',
        'JAN27',
        200,
        'C',
        'SMART',
      );
      expect(result.content[0].text).toContain('"conid": 912345678');
    });

    it('should reject option order fields before calling the IB client', async () => {
      mockIBClient.placeOrder = vi.fn().mockResolvedValue({ orderId: '123', status: 'Submitted' });

      const result = await handlers.placeOrder({
        clientOrderId: 'codex-20260716-option',
        accountId: 'U12345',
        symbol: 'AAPL',
        secType: 'OPT',
        expiry: 'JAN27',
        strike: 200,
        right: 'C',
        action: 'BUY',
        orderType: 'LMT',
        quantity: 1,
        price: 4.5,
      } as any);

      expect(result.content[0].text).toMatch(/option|secType|unsupported/i);
      expect(mockIBClient.placeOrder).not.toHaveBeenCalled();
    });
  });
});
