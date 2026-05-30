// test/tool-handlers.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ToolHandlers, ToolHandlerContext } from '../src/tool-handlers.js';
import { IBClient } from '../src/ib-client.js';
import { IBGatewayManager } from '../src/gateway-manager.js';
import { HeadlessAuthenticator } from '../src/headless-auth.js';
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(HeadlessAuthenticator).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue({ success: true }),
      close: vi.fn().mockResolvedValue(undefined),
    }) as any);

    // Create mock IBClient
    mockIBClient = {
      checkAuthenticationStatus: vi.fn().mockResolvedValue(true),
      reauthenticate: vi.fn().mockResolvedValue(undefined),
      getAccountInfo: vi.fn().mockResolvedValue({ accounts: [] }),
      getPositions: vi.fn().mockResolvedValue([]),
      getMarketData: vi.fn().mockResolvedValue({ price: 150 }),
      placeOrder: vi.fn().mockResolvedValue({ orderId: '123' }),
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
      },
    };

    handlers = new ToolHandlers(context);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    it('should place market order', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.placeOrder = vi.fn().mockResolvedValue(mockResponse);

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
      };

      const result = await handlers.placeOrder(orderInput);

      expect(result.content).toBeDefined();
      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'MKT',
          quantity: 10,
        })
      );
    });

    it('should place limit order with price', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.placeOrder = vi.fn().mockResolvedValue(mockResponse);

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'LMT' as const,
        quantity: 10,
        price: 150.50,
      };

      await handlers.placeOrder(orderInput);

      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          price: 150.50,
        })
      );
    });

    it('should forward exchange and tif to ibClient.placeOrder when provided', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.placeOrder = vi.fn().mockResolvedValue(mockResponse);

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        exchange: 'NASDAQ',
        tif: 'GTC' as const,
      };

      await handlers.placeOrder(orderInput);

      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          exchange: 'NASDAQ',
          tif: 'GTC',
        })
      );
    });

    it('should handle order placement errors', async () => {
      mockIBClient.placeOrder = vi.fn().mockRejectedValue(new Error('Order failed'));

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
      };

      const result = await handlers.placeOrder(orderInput);

      expect(result.content[0].text).toContain('Order failed');
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

    it('should throw when not authenticated on both checks', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      mockIBClient.reauthenticate = vi.fn();

      await expect((handlers as any).ensureAuth())
        .rejects.toThrow('Authentication required');
      expect(mockIBClient.reauthenticate).not.toHaveBeenCalled();
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
});
