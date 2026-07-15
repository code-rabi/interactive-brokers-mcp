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
    it('should accept valid market order', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
    });

    it('should accept fractional quantities as numbers', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 1.5,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBe(1.5);
      }
    });

    it('should accept fractional quantities as strings', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: '2.75',
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBe(2.75);
      }
    });

    it('should accept integer quantities as strings', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: '100',
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBe(100);
      }
    });

    it('should reject negative quantities', () => {
      const invalidOrder = {
        mode: 'SUBMIT' as const,
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
        mode: 'SUBMIT' as const,
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
        mode: 'SUBMIT' as const,
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
        mode: 'SUBMIT' as const,
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
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'SELL' as const,
        orderType: 'STP' as const,
        quantity: 10,
      };
      
      const result = PlaceOrderZodSchema.safeParse(invalidOrder);
      expect(result.success).toBe(false);
    });

    it('should accept valid STP order with stopPrice', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'SELL' as const,
        orderType: 'STP' as const,
        quantity: 10,
        stopPrice: 140.00,
      };
      
      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
    });

    it('should accept suppressConfirmations flag', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        suppressConfirmations: true,
      };

      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
    });

    it.each(['DAY', 'GTC', 'IOC', 'OPG'] as const)(
      'should accept tif value %s',
      (tif) => {
        const validOrder = {
          mode: 'SUBMIT' as const,
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY' as const,
          orderType: 'MKT' as const,
          quantity: 10,
          tif,
        };

        const result = PlaceOrderZodSchema.safeParse(validOrder);
        expect(result.success).toBe(true);
      }
    );

    it('should reject an invalid tif value', () => {
      const invalidOrder = {
        mode: 'SUBMIT' as const,
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

    it('should accept exchange when provided alongside required fields', () => {
      const validOrder = {
        mode: 'SUBMIT' as const,
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        exchange: 'NASDAQ',
      };

      const result = PlaceOrderZodSchema.safeParse(validOrder);
      expect(result.success).toBe(true);
    });

    it.each(['PREVIEW', 'SUBMIT'] as const)('should accept mode %s', (mode) => {
      const result = PlaceOrderZodSchema.safeParse({
        mode,
        accountId: 'U12345',
        conid: 123456,
        secType: 'FUND',
        action: 'SELL',
        orderType: 'MKT',
        fullPosition: true,
      });

      expect(result.success).toBe(true);
    });

    it('should reject unsupported modes', () => {
      const result = PlaceOrderZodSchema.safeParse({
        mode: 'DRY_RUN',
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY',
        orderType: 'MKT',
        quantity: 1,
      });

      expect(result.success).toBe(false);
    });

    it('should reject quantity together with fullPosition', () => {
      const result = PlaceOrderZodSchema.safeParse({
        mode: 'PREVIEW',
        accountId: 'U12345',
        conid: 123456,
        secType: 'FUND',
        action: 'SELL',
        orderType: 'MKT',
        quantity: 1,
        fullPosition: true,
      });

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

    it('should accept option orders with contract details', () => {
      const result = PlaceOrderZodSchema.safeParse({
        mode: 'SUBMIT',
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

      expect(result.success).toBe(true);
    });

    it('should reject option orders missing expiry when conid is not provided', () => {
      const result = PlaceOrderZodSchema.safeParse({
        mode: 'SUBMIT',
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
