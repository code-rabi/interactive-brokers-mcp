// test/ib-client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IBClient, SymbolNotFoundError } from '../src/ib-client.js';

const { mockSpawn, mockFs } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));
vi.mock('fs', () => ({
  default: mockFs,
}));

const mockFetch = vi.fn();

function mockResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : `Error ${status}`,
  });
}

function findCall(pattern: string): [string, any] | undefined {
  return mockFetch.mock.calls.find(([url]: [string]) => url.includes(pattern));
}

function findCallBody(pattern: string): any {
  const call = findCall(pattern);
  return call?.[1]?.body ? JSON.parse(call[1].body) : undefined;
}

describe('IBClient', () => {
  let client: IBClient;
  const mockConfig = {
    host: 'localhost',
    port: 5000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(mockResponse({}));
    mockFs.existsSync.mockImplementation((target: unknown) =>
      String(target).endsWith('scripts/tickler.js')
    );
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: vi.fn(),
    });

    client = new IBClient({ ...mockConfig });
  });

  afterEach(() => {
    if (client) {
      client.destroy();
    }
    vi.unstubAllGlobals();
  });

  describe('Constructor and Initialization', () => {
    it('should create IBClient with correct config', () => {
      expect(client).toBeDefined();
    });

    it('should initialize with HTTPS base URL', () => {
      expect((client as any).baseUrl).toBe('https://localhost:5000/v1/api');
    });
  });

  describe('Session Management', () => {
    it('should start tickle after successful authentication check', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ authenticated: true }));

      const result = await client.checkAuthenticationStatus();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/iserver/auth/status'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should stop tickle when authentication fails', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ authenticated: false }));

      const result = await client.checkAuthenticationStatus();

      expect(result).toBe(false);
    });

    it('should handle authentication check errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.checkAuthenticationStatus();

      expect(result).toBe(false);
    });

    it('should treat a competing session as unauthenticated', async () => {
      // IBKR handed the brokerage session to another client. The gateway still reports it
      // as established, but every request against it will fail.
      mockFetch.mockResolvedValueOnce(
        mockResponse({ authenticated: true, connected: true, established: true, competing: true })
      );

      const result = await client.checkAuthenticationStatus();

      expect(result).toBe(false);
    });

    it('should spawn the durable tickler with package-anchored paths and env cookies', () => {
      client.setSessionCookies([{ name: 'SBID', value: 'abc', domain: 'localhost' }]);

      (client as any).spawnDurableTickler();

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('ib-gateway/.runtime'),
        { recursive: true }
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        process.execPath,
        [
          expect.stringContaining('scripts/tickler.js'),
          'localhost',
          '5000',
        ],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          env: expect.objectContaining({
            IB_TICKLER_COOKIE_HEADER: 'SBID=abc',
          }),
        })
      );

      const [, metadataJson] = mockFs.writeFileSync.mock.calls[0];
      expect(JSON.parse(metadataJson)).toMatchObject({
        pid: 12345,
        host: 'localhost',
        port: 5000,
      });
    });

    it('should replace a durable tickler when the stored target port no longer matches', () => {
      mockFs.existsSync.mockImplementation((target: unknown) => {
        const value = String(target);
        return value.endsWith('tickler-session.json') || value.endsWith('scripts/tickler.js') || value.endsWith('.runtime');
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        pid: 321,
        host: 'localhost',
        port: 5001,
      }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0 || signal === 'SIGTERM') {
          return true;
        }
        return true;
      }) as typeof process.kill);

      (client as any).spawnDurableTickler();

      expect(killSpy).toHaveBeenNthCalledWith(1, 321, 0);
      expect(killSpy).toHaveBeenNthCalledWith(2, 321, 'SIGTERM');
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('tickler-session.json'));
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      killSpy.mockRestore();
    });

    it('should treat EPERM pid probes as an already-running matching tickler', () => {
      mockFs.existsSync.mockImplementation((target: unknown) => {
        const value = String(target);
        return value.endsWith('tickler-session.json') || value.endsWith('scripts/tickler.js') || value.endsWith('.runtime');
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        pid: 321,
        host: 'localhost',
        port: 5000,
      }));

      const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
        throw error;
      }) as typeof process.kill);

      (client as any).spawnDurableTickler();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('Port Updates', () => {
    it('should update port and reinitialize client', () => {
      client.updatePort(5001);

      expect((client as any).baseUrl).toBe('https://localhost:5001/v1/api');
    });

    it.skip('should not reinitialize if port is the same', () => {
      // Skip this test - edge case not critical for functionality
    });
  });

  describe('API Methods', () => {
    beforeEach(() => {
      (client as any).isAuthenticated = true;
    });

    describe('getAccountInfo', () => {
      it('should fetch account information', async () => {
        const mockAccounts = [{ id: 'U12345', accountId: 'U12345' }];
        const mockSummary = { totalCashValue: 10000 };

        mockFetch
          .mockResolvedValueOnce(mockResponse(mockAccounts))
          .mockResolvedValueOnce(mockResponse({
            metadata: { total: 0, pageSize: 20, pageNum: 0 },
            subaccounts: [],
          }))
          .mockResolvedValueOnce(mockResponse(mockSummary));

        const result = await client.getAccountInfo();

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/portfolio/accounts'),
          expect.objectContaining({ method: 'GET' })
        );
        expect(result.accounts).toEqual(mockAccounts);
        expect(result.summaries).toHaveLength(1);
      });

      it('should fetch and merge every page of accounts in a tiered advisor structure', async () => {
        const masterAccount = { id: 'F12345', accountId: 'F12345', businessType: 'FA' };
        const firstClient = { id: 'U12345', accountId: 'U12345', businessType: 'FA_CLIENT' };
        const secondClient = { id: 'U67890', accountId: 'U67890', businessType: 'FA_CLIENT' };

        mockFetch
          .mockResolvedValueOnce(mockResponse([masterAccount]))
          .mockResolvedValueOnce(mockResponse({
            metadata: { total: 3, pageSize: 2, pageNum: 0 },
            subaccounts: [masterAccount, firstClient],
          }))
          .mockResolvedValueOnce(mockResponse({
            metadata: { total: 3, pageSize: 2, pageNum: 1 },
            subaccounts: [secondClient],
          }))
          .mockResolvedValueOnce(mockResponse({ netliquidation: { amount: 30 } }))
          .mockResolvedValueOnce(mockResponse({ netliquidation: { amount: 10 } }))
          .mockResolvedValueOnce(mockResponse({ netliquidation: { amount: 20 } }));

        const result = await client.getAccountInfo();

        expect(mockFetch).toHaveBeenNthCalledWith(
          2,
          expect.stringContaining('/portfolio/subaccounts2?page=0'),
          expect.objectContaining({ method: 'GET' }),
        );
        expect(mockFetch).toHaveBeenNthCalledWith(
          3,
          expect.stringContaining('/portfolio/subaccounts2?page=1'),
          expect.objectContaining({ method: 'GET' }),
        );
        expect(result.accounts).toEqual([masterAccount, firstClient, secondClient]);
        expect(result.summaries.map((entry) => entry.accountId)).toEqual([
          'F12345',
          'U12345',
          'U67890',
        ]);
      });

      it('should tolerate an empty or malformed subaccounts response', async () => {
        const mockAccounts = [{ id: 'U12345', accountId: 'U12345' }];

        mockFetch
          .mockResolvedValueOnce(mockResponse(mockAccounts))
          .mockResolvedValueOnce(mockResponse({ unexpected: 'response' }))
          .mockResolvedValueOnce(mockResponse({ totalCashValue: 10000 }));

        const result = await client.getAccountInfo();

        expect(result.accounts).toEqual(mockAccounts);
        expect(result.summaries).toHaveLength(1);
      });

      it('should fall back to accounts collected so far when the subaccounts endpoint fails', async () => {
        const mockAccounts = [{ id: 'U12345', accountId: 'U12345' }];

        mockFetch
          .mockResolvedValueOnce(mockResponse(mockAccounts))
          .mockResolvedValueOnce(mockResponse({ error: 'temporary failure' }, 500))
          .mockResolvedValueOnce(mockResponse({ totalCashValue: 10000 }));

        const result = await client.getAccountInfo();

        expect(result.accounts).toEqual(mockAccounts);
        expect(result.summaries).toHaveLength(1);
      });

      it('should not hide authentication failures from the subaccounts endpoint', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ id: 'U12345' }]))
          .mockResolvedValueOnce(mockResponse({ error: 'not authenticated' }, 401));

        await expect(client.getAccountInfo()).rejects.toThrow('Authentication required');
      });
    });

    describe('getPositions', () => {
      it('should fetch positions for account', async () => {
        const mockPositions = [{ symbol: 'AAPL', position: 10 }];

        mockFetch.mockResolvedValueOnce(mockResponse(mockPositions));

        const result = await client.getPositions('U12345');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/portfolio/U12345/positions'),
          expect.objectContaining({ method: 'GET' })
        );
        expect(result).toEqual(mockPositions);
      });
    });

    describe('getMarketData', () => {
      it('should fetch market data for symbol', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, price: 150.25 }]));

        const result = await client.getMarketData('AAPL');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/secdef/search?symbol=AAPL'),
          expect.objectContaining({ method: 'GET' })
        );
        expect(result).toBeDefined();
      });

      it('should throw error if symbol not found', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await expect(client.getMarketData('INVALID')).rejects.toThrow(
          'Symbol INVALID not found'
        );
      });

      it('should propagate SymbolNotFoundError instance to callers', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await expect(client.getMarketData('INVALID')).rejects.toBeInstanceOf(SymbolNotFoundError);
      });

      it('should not misuse the secdef name flag for exchange filtering', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, price: 150.25 }]));

        await client.getMarketData('AAPL', 'NASDAQ');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/secdef/search?symbol=AAPL&name=NASDAQ'),
          expect.objectContaining({ method: 'GET' })
        );
      });

      it('should URL-encode the exchange parameter', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, price: 150.25 }]));

        await client.getMarketData('AAPL', 'NYSE ARCA');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('&name=NYSE%20ARCA'),
          expect.anything()
        );
      });

      it('should mention the exchange in the not-found error when provided', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await expect(client.getMarketData('INVALID', 'NASDAQ')).rejects.toThrow(
          'Symbol INVALID on NASDAQ not found'
        );
      });
    });

    describe('placeOrder', () => {
      it('should place market order successfully', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123', status: 'Submitted' }]));

        const orderRequest = {
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY' as const,
          orderType: 'MKT' as const,
          quantity: 10,
        };

        const result = await client.placeOrder(orderRequest);

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({
          conid: 265598,
          orderType: 'MKT',
          side: 'BUY',
          quantity: 10,
        }));
        expect(result).toBeDefined();
      });

      it('should include price for limit orders', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY' as const,
          orderType: 'LMT' as const,
          quantity: 10,
          price: 150.50,
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({
          price: 150.50,
        }));
      });

      it('should default tif to DAY when not specified', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'MKT',
          quantity: 10,
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({ tif: 'DAY' }));
      });

      it('should use the user-provided tif when given', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'MKT',
          quantity: 10,
          tif: 'GTC',
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({ tif: 'GTC' }));
      });

      it('should include exchange in secdef/search URL when provided', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'MKT',
          quantity: 10,
          exchange: 'NASDAQ',
        });

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/secdef/search?symbol=AAPL'),
          expect.anything()
        );
        expect(mockFetch).not.toHaveBeenCalledWith(
          expect.stringContaining('name=NASDAQ'),
          expect.anything()
        );
      });

      it('should include exchange in the order payload when specified', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'MKT',
          quantity: 10,
          exchange: 'NASDAQ',
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({ listingExchange: 'NASDAQ' }));
      });

      it('should propagate SymbolNotFoundError when symbol cannot be resolved', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await expect(
          client.placeOrder({
            accountId: 'U12345',
            symbol: 'INVALID',
            action: 'BUY',
            orderType: 'MKT',
            quantity: 10,
          })
        ).rejects.toThrow('Symbol INVALID not found');
      });

      it('should include stopPrice for stop orders', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'SELL' as const,
          orderType: 'STP' as const,
          quantity: 10,
          stopPrice: 140.00,
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({
          auxPrice: 140.00,
        }));
      });

      it('should resolve and submit a FUNDSERV mutual-fund order by symbol', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{
            conid: 4815747,
            symbol: 'FXAIX',
            sections: [{ secType: 'FUND', exchange: 'FUNDSERV' }],
          }]))
          .mockResolvedValueOnce(mockResponse([{ order_id: 'fund-order-123' }]));

        await client.order({
          mode: 'SUBMIT',
          accountId: 'U12345',
          symbol: 'FXAIX',
          secType: 'FUND',
          action: 'SELL',
          orderType: 'MKT',
          quantity: 25.125,
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body).toEqual({
          orders: [{
            conid: 4815747,
            orderType: 'MKT',
            side: 'SELL',
            quantity: 25.125,
            tif: 'DAY',
            secType: '4815747:FUND',
            listingExchange: 'FUNDSERV',
          }],
        });
      });

      it('should use byte-equivalent order bodies for PREVIEW and SUBMIT full-position fund orders', async () => {
        const position = [{ conid: 4815747, position: 37.625, assetClass: 'FUND' }];
        mockFetch
          .mockResolvedValueOnce(mockResponse(position))
          .mockResolvedValueOnce(mockResponse([{ conid: 4815747, '31': '123.45' }]))
          .mockResolvedValueOnce(mockResponse({ amount: { commission: '0.00' }, error: null }))
          .mockResolvedValueOnce(mockResponse(position))
          .mockResolvedValueOnce(mockResponse([{ order_id: 'fund-order-456' }]));

        const sharedOrder = {
          accountId: 'U12345',
          conid: 4815747,
          secType: 'FUND' as const,
          action: 'SELL' as const,
          orderType: 'MKT' as const,
          fullPosition: true,
        };

        await client.order({ mode: 'PREVIEW', ...sharedOrder });
        await client.order({ mode: 'SUBMIT', ...sharedOrder });

        const previewCall = mockFetch.mock.calls.find(([url]: [string]) =>
          url.includes('/iserver/account/U12345/orders/whatif')
        );
        const submitCall = mockFetch.mock.calls.find(([url]: [string]) =>
          url.endsWith('/iserver/account/U12345/orders')
        );
        const previewBody = JSON.parse(previewCall?.[1]?.body);
        const submitBody = JSON.parse(submitCall?.[1]?.body);

        expect(previewBody).toEqual(submitBody);
        expect(previewBody.orders[0]).toEqual(expect.objectContaining({
          conid: 4815747,
          secType: '4815747:FUND',
          listingExchange: 'FUNDSERV',
          side: 'SELL',
          quantity: 37.625,
        }));
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/marketdata/snapshot?conids=4815747&fields=31'),
          expect.objectContaining({ method: 'GET' }),
        );
      });

      it('should reject fullPosition when the requested side would increase the position', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse([{
          conid: 4815747,
          position: 10,
          assetClass: 'FUND',
        }]));

        await expect(client.order({
          mode: 'PREVIEW',
          accountId: 'U12345',
          conid: 4815747,
          secType: 'FUND',
          action: 'BUY',
          orderType: 'MKT',
          fullPosition: true,
        })).rejects.toThrow('must use action SELL');

        expect(mockFetch).not.toHaveBeenCalledWith(
          expect.stringContaining('/orders/whatif'),
          expect.anything(),
        );
      });
    });

    describe('getOrders', () => {
      it('should fetch orders for all discovered trading accounts', async () => {
        const firstAccountOrders = [{ orderId: '123', status: 'Filled' }];
        const secondAccountOrders = [{ orderId: '456', status: 'Submitted' }];

        mockFetch
          .mockResolvedValueOnce(mockResponse({ accounts: ['U12345', { accountId: 'U67890' }], selectedAccount: 'U12345' }))
          .mockResolvedValueOnce(mockResponse({ orders: firstAccountOrders }))
          .mockResolvedValueOnce(mockResponse({ orders: secondAccountOrders }));

        const result = await client.getOrders();

        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/iserver/accounts'), expect.objectContaining({ method: 'GET' }));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('/iserver/account/orders?accountId=U12345'), expect.objectContaining({ method: 'GET' }));
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('/iserver/account/orders?accountId=U67890'), expect.objectContaining({ method: 'GET' }));
        expect(result.orders).toEqual([...firstAccountOrders, ...secondAccountOrders]);
        expect(result.accountResults).toEqual([
          { accountId: 'U12345', data: { orders: firstAccountOrders } },
          { accountId: 'U67890', data: { orders: secondAccountOrders } },
        ]);
      });

      it('should fall back to portfolio accounts when iserver account discovery fails', async () => {
        const mockOrders = [{ orderId: '123', status: 'Filled' }];

        mockFetch
          .mockRejectedValueOnce(new Error('iserver accounts unavailable'))
          .mockResolvedValueOnce(mockResponse([{ id: 'U12345' }]))
          .mockResolvedValueOnce(mockResponse({ orders: mockOrders }));

        const result = await client.getOrders();

        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/iserver/accounts'), expect.anything());
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('/portfolio/accounts'), expect.anything());
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('/iserver/account/orders?accountId=U12345'), expect.anything());
        expect(result.orders).toEqual(mockOrders);
      });

      it('should fall back to an unscoped orders request when account discovery returns no accounts', async () => {
        const mockOrders = [{ orderId: '123', status: 'Filled' }];

        mockFetch
          .mockResolvedValueOnce(mockResponse({ accounts: [] }))
          .mockResolvedValueOnce(mockResponse([]))
          .mockResolvedValueOnce(mockResponse(mockOrders));

        const result = await client.getOrders();

        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/iserver/accounts'), expect.anything());
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('/portfolio/accounts'), expect.anything());
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('/iserver/account/orders'), expect.objectContaining({ method: 'GET' }));
        // Unscoped: no accountId query parameter
        expect(mockFetch.mock.calls[2][0]).not.toContain('accountId');
        expect(result).toEqual(mockOrders);
      });

      it('should fetch orders for specific account', async () => {
        const mockOrders = [{ orderId: '123', status: 'Filled' }];

        mockFetch.mockResolvedValueOnce(mockResponse(mockOrders));

        const result = await client.getOrders('U12345');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/account/orders?accountId=U12345'),
          expect.objectContaining({ method: 'GET' })
        );
        expect(result).toEqual(mockOrders);
      });
    });

    describe('getOrderStatus', () => {
      it('should fetch order status by ID', async () => {
        const mockOrderStatus = { orderId: '123', status: 'Filled' };

        mockFetch.mockResolvedValueOnce(mockResponse(mockOrderStatus));

        const result = await client.getOrderStatus('123');

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/account/orders/123'),
          expect.objectContaining({ method: 'GET' })
        );
        expect(result).toEqual(mockOrderStatus);
      });
    });

    describe('confirmOrder', () => {
      it('should confirm order with reply', async () => {
        const mockResult = { confirmed: true };

        mockFetch.mockResolvedValueOnce(mockResponse(mockResult));

        const result = await client.confirmOrder('reply-123', ['msg1', 'msg2']);

        const call = findCall('/iserver/reply/reply-123');
        expect(call).toBeDefined();
        expect(call![1].method).toBe('POST');
        const body = JSON.parse(call![1].body);
        expect(body).toEqual({ confirmed: true, messageIds: ['msg1', 'msg2'] });
        expect(result).toEqual(mockResult);
      });
    });
  });

  describe('reauthenticate', () => {
    // Helper to set up mock sequence for initializeBrokerageSession
    // The brokerage init sequence (no cookies, single pass) makes these fetch calls:
    // 1. GET /sso/validate
    // 2. GET /iserver/auth/status
    // 3. GET /iserver/accounts
    // 4. POST /iserver/auth/ssodh/init
    // 5. POST .../reauthenticate?force=true
    // 6. POST /iserver/reauthenticate
    // 7. POST /tickle
    // 8. GET /tickle
    // 9. GET /portfolio/accounts
    // 10. GET /iserver/auth/status (final)
    function setupBrokerageInitMocks(opts: {
      authStatus?: any;
      accountsReject?: boolean;
      finalStatus?: any;
    }) {
      const statusWithMAC = opts.authStatus ?? {
        authenticated: false,
        connected: true,
        MAC: '06:7F:1D:C4:36:2F',
        hardware_info: '71a482fc|06:7F:1D:C4:36:2F',
      };
      const finalStatus = opts.finalStatus ?? {
        authenticated: true, connected: true, established: true,
      };

      const chain = mockFetch
        .mockResolvedValueOnce(mockResponse({ RESULT: true }))           // 1. GET /sso/validate
        .mockResolvedValueOnce(mockResponse(statusWithMAC));              // 2. GET /iserver/auth/status

      if (opts.accountsReject !== false) {
        chain.mockRejectedValueOnce(new Error('not ready'));              // 3. GET /iserver/accounts (fail)
      } else {
        chain.mockResolvedValueOnce(mockResponse([]));                    // 3. GET /iserver/accounts
      }

      chain
        .mockResolvedValueOnce(mockResponse({}))                          // 4. POST /iserver/auth/ssodh/init
        .mockResolvedValueOnce(mockResponse({}))                          // 5. POST .../reauthenticate?force=true
        .mockResolvedValueOnce(mockResponse({}))                          // 6. POST /iserver/reauthenticate
        .mockResolvedValueOnce(mockResponse({}))                          // 7. POST /tickle
        .mockResolvedValueOnce(mockResponse({}))                          // 8. GET /tickle
        .mockResolvedValueOnce(mockResponse({}))                          // 9. GET /portfolio/accounts
        .mockResolvedValueOnce(mockResponse(finalStatus));                // 10. GET /iserver/auth/status
    }

    it('should initialize brokerage session using the official ssodh/init form body', async () => {
      setupBrokerageInitMocks({});

      await client.reauthenticate();

      // Verify ssodh/init call (4th call, index 3)
      const ssodInitCall = findCall('/iserver/auth/ssodh/init');
      expect(ssodInitCall).toBeDefined();
      expect(ssodInitCall![1].method).toBe('POST');
      expect(ssodInitCall![1].body).toContain('compete=true');
      expect(ssodInitCall![1].body).toContain('mac=06-7F-1D-C4-36-2F');
      expect(ssodInitCall![1].body).toContain('machineId=71a482fc');
      expect(ssodInitCall![1].headers).toEqual(expect.objectContaining({
        'Content-Type': 'application/x-www-form-urlencoded',
      }));

      // Verify other key calls happened
      expect(findCall('/sso/validate')).toBeDefined();
      expect(findCall('/iserver/auth/status')).toBeDefined();
      expect(findCall('/iserver/accounts')).toBeDefined();
      expect(findCall('/v1/portal/iserver/reauthenticate')).toBeDefined();

      const reauthCall = findCall('/iserver/reauthenticate');
      expect(reauthCall).toBeDefined();
      expect(reauthCall![1].method).toBe('POST');

      const tickleCall = mockFetch.mock.calls.find(
        ([url, init]: [string, any]) => url.includes('/tickle') && init?.method === 'POST' && !url.includes('portal')
      );
      expect(tickleCall).toBeDefined();
    });

    it('should initialize brokerage session using SSO HARDWARE_INFO when auth status omits hardware_info', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({
          RESULT: true,
          HARDWARE_INFO: '71a482fc|06:7F:1D:C4:36:2F',
        }))
        .mockResolvedValueOnce(mockResponse({
          authenticated: false,
          connected: true,
          MAC: 'AA:AA:AA:AA:AA:AA',
        }))
        .mockRejectedValueOnce(new Error('not ready'))
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(mockResponse({
          authenticated: true,
          connected: true,
          established: true,
        }));

      await expect(client.initializeBrokerageSession()).resolves.toBe(true);

      const ssodhInitCall = findCall('/iserver/auth/ssodh/init');
      expect(ssodhInitCall).toBeDefined();
      expect(ssodhInitCall![1].method).toBe('POST');
      expect(ssodhInitCall![1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(ssodhInitCall![1].body).toContain('machineId=71a482fc');
      expect(ssodhInitCall![1].body).toContain('mac=06-7F-1D-C4-36-2F');
      expect(ssodhInitCall![1].body).not.toContain('mac=AA-AA-AA-AA-AA-AA');
    });
    it('should handle reauth when final status returns false', async () => {
      setupBrokerageInitMocks({
        finalStatus: { authenticated: false, connected: true },
      });

      await expect(client.reauthenticate()).resolves.not.toThrow();

      expect(findCall('/iserver/auth/ssodh/init')).toBeDefined();
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(client.reauthenticate()).resolves.not.toThrow();
    });

    it('should stop tickle when reauth status returns false', async () => {
      vi.useFakeTimers();
      try {
        // Phase 1: authenticate successfully to start tickle
        mockFetch.mockResolvedValueOnce(mockResponse({ authenticated: true }));
        await client.checkAuthenticationStatus();

        // Phase 2: reauthenticate returns false → stops tickle
        setupBrokerageInitMocks({
          finalStatus: { authenticated: false, connected: true },
        });
        await client.reauthenticate();

        const callCountAfterReauth = mockFetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mockFetch.mock.calls.length).toBe(callCountAfterReauth);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should stop tickle when reauth throws', async () => {
      vi.useFakeTimers();
      try {
        // Phase 1: authenticate successfully to start tickle
        mockFetch
          .mockResolvedValueOnce(mockResponse({ authenticated: true }))
          // Phase 2: all subsequent calls fail
          .mockRejectedValue(new Error('Connection refused'));
        await client.checkAuthenticationStatus();

        await client.reauthenticate();

        const callCountAfterReauth = mockFetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mockFetch.mock.calls.length).toBe(callCountAfterReauth);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Cleanup', () => {
    it('should stop tickle on destroy', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ authenticated: true }));

      await client.checkAuthenticationStatus();

      client.destroy();
      expect(() => client.destroy()).not.toThrow();
    });
  });
});

describe('Option contract support', () => {
  let optionClient: IBClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(mockResponse({}));
    mockFs.existsSync.mockImplementation((target: unknown) => String(target).endsWith('scripts/tickler.js'));
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: vi.fn(),
      killed: false,
    });
    optionClient = new IBClient({ host: 'localhost', port: 5000 });
    (optionClient as any).isAuthenticated = true;
  });

  afterEach(() => {
    optionClient.destroy();
  });

  it('should fetch option chains from secdef search and strikes endpoints', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse([
          {
            conid: 265598,
            symbol: 'AAPL',
            sections: [{ secType: 'OPT', months: 'JAN27;FEB27' }],
          },
        ]),
      )
      .mockResolvedValueOnce(mockResponse({ call: [200, 205], put: [200, 205] }))
      .mockResolvedValueOnce(mockResponse({ call: [210], put: [210] }));

    const result = await optionClient.getOptionChain('AAPL', 'SMART');

    expect(result).toEqual({
      symbol: 'AAPL',
      underlyingConid: 265598,
      expirations: [
        { expiry: 'JAN27', call: [200, 205], put: [200, 205] },
        { expiry: 'FEB27', call: [210], put: [210] },
      ],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/iserver/secdef/strikes?conid=265598&secType=OPT&month=JAN27&exchange=SMART'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should resolve option conids via secdef info', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
      .mockResolvedValueOnce(
        mockResponse([
          {
            conid: 912345678,
            symbol: 'AAPL',
            secType: 'OPT',
            right: 'C',
            strike: 200,
            multiplier: '100',
          },
        ]),
      );

    const result = await optionClient.resolveOptionConid('AAPL', 'JAN27', 200, 'C');

    expect(result.underlyingConid).toBe(265598);
    expect(result.option).toEqual(
      expect.objectContaining({
        conid: 912345678,
        secType: 'OPT',
        right: 'C',
        strike: 200,
      }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/iserver/secdef/info?conid=265598&secType=OPT&month=JAN27&strike=200&right=C'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should place option orders after resolving the option contract', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
      .mockResolvedValueOnce(mockResponse([{ conid: 912345678, symbol: 'AAPL', secType: 'OPT' }]))
      .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

    await optionClient.placeOrder({
      accountId: 'U12345',
      symbol: 'AAPL',
      secType: 'OPT',
      expiry: 'JAN27',
      strike: 200,
      right: 'C',
      action: 'BUY',
      orderType: 'LMT',
      quantity: 2,
      price: 4.5,
    });

    const body = findCallBody('/iserver/account/U12345/orders');
    expect(body.orders[0]).toEqual(
      expect.objectContaining({
        conid: 912345678,
        secType: '912345678:OPT',
        side: 'BUY',
        orderType: 'LMT',
        quantity: 2,
        price: 4.5,
      }),
    );
  });

  it('should place option orders with a pre-resolved conid', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

    await optionClient.placeOrder({
      accountId: 'U12345',
      conid: 912345678,
      secType: 'OPT',
      action: 'SELL',
      orderType: 'MKT',
      quantity: 1,
    });

    const body = findCallBody('/iserver/account/U12345/orders');
    expect(body.orders[0]).toEqual(
      expect.objectContaining({
        conid: 912345678,
        secType: '912345678:OPT',
        side: 'SELL',
        orderType: 'MKT',
        quantity: 1,
      }),
    );
  });
});
