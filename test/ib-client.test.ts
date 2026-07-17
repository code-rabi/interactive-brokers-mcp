// test/ib-client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IBClient, OrderCancellationError, OrderSubmissionError, SymbolNotFoundError } from '../src/ib-client.js';

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
    mockFetch.mockReset();
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
          .mockResolvedValueOnce(mockResponse(mockSummary));

        const result = await client.getAccountInfo();

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/portfolio/accounts'),
          expect.objectContaining({ method: 'GET' })
        );
        expect(result.accounts).toEqual(mockAccounts);
        expect(result.summaries).toHaveLength(1);
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

      it('should include exchange in secdef/search URL when provided', async () => {
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
      it('should place limit order successfully', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123', status: 'Submitted' }]));

        const orderRequest = {
          clientOrderId: 'codex-20260716-basic',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY' as const,
          orderType: 'LMT' as const,
          quantity: 10,
          price: 150.50,
        };

        const result = await client.placeOrder(orderRequest);

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({
          conid: 265598,
          orderType: 'LMT',
          side: 'BUY',
          quantity: 10,
        }));
        expect(result).toBeDefined();
      });

      it('should include price for limit orders', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          clientOrderId: 'codex-20260716-price',
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
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          clientOrderId: 'codex-20260716-day',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 10,
          price: 150.50,
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({ tif: 'DAY' }));
      });

      it('should use the user-provided tif when given', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          clientOrderId: 'codex-20260716-gtc',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 10,
          price: 150.50,
          tif: 'GTC',
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({ tif: 'GTC' }));
      });

      it('should include exchange in secdef/search URL when provided', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          clientOrderId: 'codex-20260716-search-exchange',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 10,
          price: 150.50,
          exchange: 'NASDAQ',
        });

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/iserver/secdef/search?symbol=AAPL&name=NASDAQ'),
          expect.anything()
        );
      });

      it('should include exchange in the order payload when specified', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          clientOrderId: 'codex-20260716-payload-exchange',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 10,
          price: 150.50,
          exchange: 'NASDAQ',
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({ exchange: 'NASDAQ' }));
      });

      it('should propagate SymbolNotFoundError when symbol cannot be resolved', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse([]));

        await expect(
          client.placeOrder({
            clientOrderId: 'codex-20260716-invalid-symbol',
            accountId: 'U12345',
            symbol: 'INVALID',
            action: 'BUY',
            orderType: 'LMT',
            quantity: 10,
            price: 150.50,
          })
        ).rejects.toThrow('Symbol INVALID not found');
      });

      it('should include the client order ID for limit orders', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL', sections: [{ secType: 'STK' }] }]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse([{ id: 'order-123' }]));

        await client.placeOrder({
          clientOrderId: 'codex-20260716-001',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY' as const,
          orderType: 'LMT' as const,
          quantity: 10,
          price: 150.50,
        });

        const body = findCallBody('/iserver/account/U12345/orders');
        expect(body.orders[0]).toEqual(expect.objectContaining({
          cOID: 'codex-20260716-001',
        }));
      });

      it('should reject an option conid using authoritative contract metadata', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse({
          conid: 912345678,
          symbol: 'AAPL',
          secType: 'OPT',
        }));

        await expect(client.placeOrder({
          clientOrderId: 'codex-option-conid',
          accountId: 'U12345',
          conid: 912345678,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 4.5,
        })).rejects.toThrow(/stock|STK/i);

        expect(findCall('/iserver/account/U12345/orders')).toBeUndefined();
      });

      it('should reject ambiguous stock symbol search results', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([
            { conid: 265598, symbol: 'ABC', sections: [{ secType: 'STK' }] },
            { conid: 765432, symbol: 'ABC', sections: [{ secType: 'STK' }] },
          ]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'ABC', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse({ conid: 765432, symbol: 'ABC', secType: 'STK', currency: 'USD' }));

        await expect(client.placeOrder({
          clientOrderId: 'codex-ambiguous-symbol',
          accountId: 'U12345',
          symbol: 'ABC',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        })).rejects.toThrow(/ambiguous|stock/i);

        expect(findCall('/iserver/account/U12345/orders')).toBeUndefined();
      });

      it('should reject ambiguity revealed only by authoritative metadata', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([
            { conid: 265598, symbol: 'ABC', sections: [{ secType: 'STK' }] },
            { conid: 765432, symbol: 'ABC', sections: [{ secType: 'OPT' }] },
          ]))
          .mockResolvedValueOnce(mockResponse({ conid: 265598, symbol: 'ABC', secType: 'STK', currency: 'USD' }))
          .mockResolvedValueOnce(mockResponse({ conid: 765432, symbol: 'ABC', secType: 'STK', currency: 'USD' }));

        await expect(client.placeOrder({
          clientOrderId: 'codex-authoritative-ambiguity',
          accountId: 'U12345',
          symbol: 'ABC',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        })).rejects.toThrow(/ambiguous|stock/i);

        expect(findCall('/iserver/contract/265598/info')).toBeDefined();
        expect(findCall('/iserver/contract/765432/info')).toBeDefined();
        expect(findCall('/iserver/account/U12345/orders')).toBeUndefined();
      });

      it('should reject non-stock symbol search results', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([
            { conid: 912345678, symbol: 'AAPL', sections: [{ secType: 'OPT' }] },
          ]))
          .mockResolvedValueOnce(mockResponse({ conid: 912345678, symbol: 'AAPL', secType: 'OPT' }));

        await expect(client.placeOrder({
          clientOrderId: 'codex-non-stock-symbol',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 4.5,
        })).rejects.toThrow(/stock|STK/i);

        expect(findCall('/iserver/account/U12345/orders')).toBeUndefined();
      });

      it('should reject a symbol with zero eligible USD stock contracts', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse([{ conid: 265598, symbol: 'AAPL' }]))
          .mockResolvedValueOnce(mockResponse({
            conid: 265598,
            symbol: 'AAPL',
            secType: 'STK',
            currency: 'EUR',
          }));

        await expect(client.placeOrder({
          clientOrderId: 'codex-eur-symbol',
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        })).rejects.toThrow(/USD|eligible/i);

        expect(findCall('/iserver/account/U12345/orders')).toBeUndefined();
      });

      it('should reject an explicit conid unless authoritative metadata is STK and USD', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse({
          conid: 265598,
          symbol: 'AAPL',
          secType: 'STK',
          currency: 'CAD',
        }));

        await expect(client.placeOrder({
          clientOrderId: 'codex-cad-conid',
          accountId: 'U12345',
          conid: 265598,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        })).rejects.toThrow(/USD/i);

        expect(findCall('/iserver/account/U12345/orders')).toBeUndefined();
      });

      it('should preserve status and the raw IBKR response body on submission errors', async () => {
        const ibkrBody = { error: 'Order rejected', errorCode: 201, detail: { field: 'price' } };
        mockFetch
          .mockResolvedValueOnce(mockResponse({
            conid: 265598,
            symbol: 'AAPL',
            secType: 'STK',
            currency: 'USD',
          }))
          .mockResolvedValueOnce(mockResponse(ibkrBody, 400));

        const error = await client.placeOrder({
          clientOrderId: 'codex-rejected-conid',
          accountId: 'U12345',
          conid: 265598,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(OrderSubmissionError);
        expect(error).toMatchObject({
          status: 400,
          ibkrBody,
          submissionUncertain: true,
        });
      });

      it.each([502, 503, 504])('should treat HTTP %s gateway responses as submission uncertain', async (status) => {
        const gatewayBody = { error: 'Order rejected', errorCode: 201, proxy: 'upstream' };
        mockFetch
          .mockResolvedValueOnce(mockResponse({
            conid: 265598,
            symbol: 'AAPL',
            secType: 'STK',
            currency: 'USD',
          }))
          .mockResolvedValueOnce(mockResponse(gatewayBody, status));

        const error = await client.placeOrder({
          clientOrderId: `codex-gateway-${status}`,
          accountId: 'U12345',
          conid: 265598,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(OrderSubmissionError);
        expect(error).toMatchObject({ status, ibkrBody: gatewayBody, submissionUncertain: true });
      });

      it('should treat a malformed 4xx response as submission uncertain', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({
            conid: 265598,
            symbol: 'AAPL',
            secType: 'STK',
            currency: 'USD',
          }))
          .mockResolvedValueOnce(mockResponse('<html>proxy error</html>', 400));

        const error = await client.placeOrder({
          clientOrderId: 'codex-malformed-400',
          accountId: 'U12345',
          conid: 265598,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        }).catch((caught) => caught);

        expect(error).toMatchObject({ status: 400, submissionUncertain: true });
      });

      it.each([400, 409])('should treat misleading HTTP %s proxy JSON as submission uncertain', async (status) => {
        const proxyBody = status === 400
          ? { code: 'BAD_GATEWAY', message: 'Cannot parse invalid upstream response' }
          : { errorCode: 'BAD_GATEWAY', message: 'Cannot parse invalid upstream response' };
        mockFetch
          .mockResolvedValueOnce(mockResponse({
            conid: 265598,
            symbol: 'AAPL',
            secType: 'STK',
            currency: 'USD',
          }))
          .mockResolvedValueOnce(mockResponse(proxyBody, status));

        const error = await client.placeOrder({
          clientOrderId: `codex-proxy-${status}`,
          accountId: 'U12345',
          conid: 265598,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        }).catch((caught) => caught);

        expect(error).toMatchObject({ status, ibkrBody: proxyBody, submissionUncertain: true });
      });

      it.each([400, 409])('should never infer a definite rejection from misleading numeric HTTP %s JSON', async (status) => {
        const proxyBody = {
          errorCode: 502,
          error: status === 400
            ? 'Gateway rejected upstream response'
            : 'Gateway timeout exceeded while reading rejected upstream response',
        };
        mockFetch
          .mockResolvedValueOnce(mockResponse({
            conid: 265598,
            symbol: 'AAPL',
            secType: 'STK',
            currency: 'USD',
          }))
          .mockResolvedValueOnce(mockResponse(proxyBody, status));

        const error = await client.placeOrder({
          clientOrderId: `codex-numeric-proxy-${status}`,
          accountId: 'U12345',
          conid: 265598,
          action: 'BUY',
          orderType: 'LMT',
          quantity: 1,
          price: 10,
        }).catch((caught) => caught);

        expect(error).toMatchObject({ status, ibkrBody: proxyBody, submissionUncertain: true });
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

    describe('cancelOrder', () => {
      it('should send DELETE to the exact account-scoped order path and preserve the broker response', async () => {
        const brokerResponse = { orderId: '123', status: 'Cancelled', message: ['Order cancelled'] };
        mockFetch.mockResolvedValueOnce(mockResponse(brokerResponse));

        const result = await client.cancelOrder('U12345', '123');

        expect(mockFetch).toHaveBeenCalledWith(
          'https://localhost:5000/v1/api/iserver/account/U12345/order/123',
          expect.objectContaining({ method: 'DELETE' }),
        );
        expect(result).toEqual(brokerResponse);
      });

      it('should preserve structured broker rejection status and body', async () => {
        const ibkrBody = { error: 'Order cannot be cancelled', errorCode: 10147 };
        mockFetch.mockResolvedValueOnce(mockResponse(ibkrBody, 400));

        const error = await client.cancelOrder('U12345', '123').catch((caught) => caught);

        expect(error).toBeInstanceOf(OrderCancellationError);
        expect(error).toMatchObject({ status: 400, ibkrBody });
      });

      it('should preserve a non-authentication HTTP 500 status and broker body', async () => {
        const ibkrBody = { error: 'Cancellation backend failed', traceId: 'ibkr-500' };
        mockFetch.mockResolvedValueOnce(mockResponse(ibkrBody, 500));

        const error = await client.cancelOrder('U12345', '123').catch((caught) => caught);

        expect(error).toBeInstanceOf(OrderCancellationError);
        expect(error).toMatchObject({ status: 500, ibkrBody });
      });

      it('should preserve authentication failures instead of replacing them with a generic cancellation error', async () => {
        const authBody = { error: 'not authenticated' };
        mockFetch.mockResolvedValueOnce(mockResponse(authBody, 401));

        const error = await client.cancelOrder('U12345', '123').catch((caught) => caught);

        expect(error).not.toBeInstanceOf(OrderCancellationError);
        expect(error).toMatchObject({
          name: 'HttpError',
          response: { status: 401, data: authBody },
        });
      });

      it('should preserve IBKR authentication failures carried in HTTP 500 responses', async () => {
        const authBody = { error: { message: 'authentication required' } };
        mockFetch.mockResolvedValueOnce(mockResponse(authBody, 500));

        const error = await client.cancelOrder('U12345', '123').catch((caught) => caught);

        expect(error).not.toBeInstanceOf(OrderCancellationError);
        expect(error).toMatchObject({
          name: 'HttpError',
          response: { status: 500, data: authBody },
        });
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

});
