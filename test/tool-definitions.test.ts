// test/tool-definitions.test.ts
import { describe, it, expect } from 'vitest';
import {
  PlaceOrderZodSchema,
  GetPositionsZodSchema,
  GetMarketDataZodSchema,
  GetLiveOrdersZodSchema,
  GetOrderStatusZodSchema,
  ConfirmOrderZodSchema,
  CreateAlertZodSchema,
  ActivateAlertZodSchema,
  DeleteAlertZodSchema,
} from '../src/tool-definitions.js';

describe('Tool Definitions - Zod Schemas', () => {
  describe('PlaceOrderZodSchema', () => {
    const validLimitOrder = {
      clientOrderId: 'codex-20260716-001',
      accountId: 'U12345',
      symbol: 'AAPL',
      action: 'BUY' as const,
      orderType: 'LMT' as const,
      quantity: 10,
      price: 150.50,
    };

    it('should accept a valid limit stock order by symbol or conid', () => {
      expect(PlaceOrderZodSchema.safeParse(validLimitOrder).success).toBe(true);
      expect(PlaceOrderZodSchema.safeParse({
        ...validLimitOrder,
        symbol: undefined,
        conid: 265598,
      }).success).toBe(true);
    });

    it('leaves the symbol-or-conid cross-field rule to the order policy', () => {
      expect(PlaceOrderZodSchema.safeParse({ ...validLimitOrder, symbol: undefined }).success).toBe(true);
    });

    it.each([
      ['MKT', { orderType: 'MKT' }],
      ['STP', { orderType: 'STP', stopPrice: 140 }],
      ['option secType', { secType: 'OPT' }],
      ['option expiry', { expiry: 'JAN27' }],
      ['option strike', { strike: 200 }],
      ['option right', { right: 'C' }],
      ['suppress confirmations', { suppressConfirmations: true }],
    ])('should reject unsafe order input %s', (_label, override) => {
      expect(PlaceOrderZodSchema.safeParse({ ...validLimitOrder, ...override }).success).toBe(false);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject invalid price %s',
      (price) => expect(PlaceOrderZodSchema.safeParse({ ...validLimitOrder, price }).success).toBe(false),
    );

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'should reject invalid quantity %s',
      (quantity) => expect(PlaceOrderZodSchema.safeParse({ ...validLimitOrder, quantity }).success).toBe(false),
    );

    it('should reject a blank client order ID', () => {
      expect(PlaceOrderZodSchema.safeParse({ ...validLimitOrder, clientOrderId: '   ' }).success).toBe(false);
    });

    it('should reject a market order', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
    });

    it('should reject a market order with fractional numeric quantity', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 1.5,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
      if (result.success) {
        expect(result.data.quantity).toBe(1.5);
      }
    });

    it('should reject a market order with fractional string quantity', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: '2.75',
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
      if (result.success) {
        expect(result.data.quantity).toBe(2.75);
      }
    });

    it('should reject a market order with integer string quantity', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: '100',
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
      if (result.success) {
        expect(result.data.quantity).toBe(100);
      }
    });

    it('should reject negative quantities', () => {
      const invalidOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: -10,
      };
      
      const result = PlaceOrderZodSchema.safeParse(invalidOrder);
      expect(result.success).toBe(false);
    });

    it('should reject zero quantity', () => {
      const invalidOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 0,
      };
      
      const result = PlaceOrderZodSchema.safeParse(invalidOrder);
      expect(result.success).toBe(false);
    });

    it('should require price for LMT orders', () => {
      const invalidOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'LMT' as const,
        quantity: 10,
      };
      
      const result = PlaceOrderZodSchema.safeParse(invalidOrder);
      expect(result.success).toBe(false);
    });

    it('should accept valid LMT order with price', () => {
      const validOrder = {
        clientOrderId: 'codex-20260716-002',
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'LMT' as const,
        quantity: 10,
        price: 150.50,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
    });

    it('should require stopPrice for STP orders', () => {
      const invalidOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'SELL' as const,
        orderType: 'STP' as const,
        quantity: 10,
      };
      
      const result = PlaceOrderZodSchema.safeParse(invalidOrder);
      expect(result.success).toBe(false);
    });

    it('should reject an STP order with stopPrice', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'SELL' as const,
        orderType: 'STP' as const,
        quantity: 10,
        stopPrice: 140.00,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
    });

    it('should reject suppressConfirmations', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        suppressConfirmations: true,
      };

      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
    });

    it.each(['DAY', 'GTC', 'IOC', 'OPG'] as const)(
      'should reject MKT orders even with tif value %s',
      (tif) => {
        const validOrder = {
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY' as const,
          orderType: 'MKT' as const,
          quantity: 10,
          tif,
        };

        const result = PlaceOrderZodSchema.safeParse(validOrder);
        expect(result.success).toBe(false);
      }
    );

    it('should reject an invalid tif value', () => {
      const invalidOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        tif: 'BAD',
      };

      const result = PlaceOrderZodSchema.safeParse(invalidOrder);
      expect(result.success).toBe(false);
    });

    it('should reject MKT orders even with exchange', () => {
      const validOrder = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        exchange: 'NASDAQ',
      };

      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(false);
    });
  });

  describe('GetPositionsZodSchema', () => {
    it('should accept accountId', () => {
      const result = GetPositionsZodSchema.safeParse({ accountId: 'U12345' });
      expect(result.success).toBe(true);
    });

    it('should require accountId', () => {
      const result = GetPositionsZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('GetMarketDataZodSchema', () => {
    it('should require symbol', () => {
      const result = GetMarketDataZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept symbol only', () => {
      const result = GetMarketDataZodSchema.safeParse({ symbol: 'AAPL' });
      expect(result.success).toBe(true);
    });

    it('should accept symbol with exchange', () => {
      const result = GetMarketDataZodSchema.safeParse({ 
        symbol: 'AAPL', 
        exchange: 'NASDAQ' 
      });
      expect(result.success).toBe(true);
    });
  });

  describe('GetLiveOrdersZodSchema', () => {
    it('should accept empty object', () => {
      const result = GetLiveOrdersZodSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept accountId', () => {
      const result = GetLiveOrdersZodSchema.safeParse({ accountId: 'U12345' });
      expect(result.success).toBe(true);
    });
  });

  describe('GetOrderStatusZodSchema', () => {
    it('should require orderId', () => {
      const result = GetOrderStatusZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept valid orderId', () => {
      const result = GetOrderStatusZodSchema.safeParse({ orderId: '12345' });
      expect(result.success).toBe(true);
    });
  });

  describe('ConfirmOrderZodSchema', () => {
    it('should require replyId and messageIds', () => {
      const result = ConfirmOrderZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept valid confirmation data', () => {
      const result = ConfirmOrderZodSchema.safeParse({
        replyId: 'reply-123',
        messageIds: ['msg1', 'msg2'],
      });
      expect(result.success).toBe(true);
    });

    it('should require messageIds to be an array', () => {
      const result = ConfirmOrderZodSchema.safeParse({
        replyId: 'reply-123',
        messageIds: 'msg1',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('CreateAlertZodSchema', () => {
    it('should require accountId and alertRequest', () => {
      const result = CreateAlertZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept valid alert creation request', () => {
      const result = CreateAlertZodSchema.safeParse({
        accountId: 'U12345',
        alertRequest: {
          alertName: 'Price Alert',
          conditions: [
            {
              conidex: '265598',
              type: 'price',
              operator: '>',
              triggerMethod: 'last',
              value: '150',
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept alert request with optional fields', () => {
      const result = CreateAlertZodSchema.safeParse({
        accountId: 'U12345',
        alertRequest: {
          alertName: 'Price Alert',
          alertMessage: 'AAPL hit $150',
          showPopup: 1,
          emailNotification: 'test@example.com',
          conditions: [
            {
              conidex: '265598',
              type: 'price',
              operator: '>',
              triggerMethod: 'last',
              value: '150',
              timeZone: 'America/New_York',
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('should require conditions array', () => {
      const result = CreateAlertZodSchema.safeParse({
        accountId: 'U12345',
        alertRequest: {
          alertName: 'Price Alert',
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ActivateAlertZodSchema', () => {
    it('should require accountId and alertId', () => {
      const result = ActivateAlertZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept valid activation request', () => {
      const result = ActivateAlertZodSchema.safeParse({
        accountId: 'U12345',
        alertId: 'alert-123',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing alertId', () => {
      const result = ActivateAlertZodSchema.safeParse({
        accountId: 'U12345',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DeleteAlertZodSchema', () => {
    it('should require accountId and alertId', () => {
      const result = DeleteAlertZodSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept valid deletion request', () => {
      const result = DeleteAlertZodSchema.safeParse({
        accountId: 'U12345',
        alertId: 'alert-123',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing accountId', () => {
      const result = DeleteAlertZodSchema.safeParse({
        alertId: 'alert-123',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Option contract schemas', () => {
    it('should accept valid option chain requests', async () => {
      const { GetOptionChainZodSchema } = await import('../src/tool-definitions.js');

      const result = GetOptionChainZodSchema.safeParse({
        symbol: 'AAPL',
        exchange: 'SMART',
      });

      expect(result.success).toBe(true);
    });

    it('should accept valid option conid resolution requests', async () => {
      const { ResolveOptionConidZodSchema } = await import('../src/tool-definitions.js');

      const result = ResolveOptionConidZodSchema.safeParse({
        symbol: 'AAPL',
        expiry: 'JAN27',
        strike: '200',
        right: 'C',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.strike).toBe(200);
      }
    });

    it('should reject option orders with contract details', () => {
      const result = PlaceOrderZodSchema.safeParse({
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
      });

      expect(result.success).toBe(false);
    });

    it('should reject option orders missing expiry when conid is not provided', () => {
      const result = PlaceOrderZodSchema.safeParse({
        accountId: 'U12345',
        symbol: 'AAPL',
        secType: 'OPT',
        strike: 200,
        right: 'C',
        action: 'BUY',
        orderType: 'MKT',
        quantity: 1,
      });

      expect(result.success).toBe(false);
    });
  });
});
