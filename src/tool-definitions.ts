// tool-definitions.ts
import { z } from "zod";

// ── Zod Schemas ──────────────────────────────────────────────────────────────
// Helper for tolerant number (allows "1", "1.5", or actual number for fractional shares)
const IntegerOrStringIntegerZod = z.union([
  z.number().positive(),
  z.string().regex(/^[0-9]+(\.[0-9]+)?$/).transform(val => parseFloat(val))
]);

// Zod Raw Shapes (for server.tool() method)
export const AuthenticateZodShape = {
  confirm: z.literal(true)
};

export const GetAccountInfoZodShape = {
  confirm: z.literal(true)
};

export const GetPositionsZodShape = {
  accountId: z.string()
};

export const GetMarketDataZodShape = {
  symbol: z.string(),
  exchange: z.string().optional()
};

export const PlaceOrderZodShape = {
  accountId: z.string(),
  symbol: z.string(),
  action: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MKT", "LMT", "STP"]),
  quantity: IntegerOrStringIntegerZod,
  price: z.number().optional(),
  stopPrice: z.number().optional(),
  suppressConfirmations: z.boolean().optional(),
  exchange: z.string().optional(),
  tif: z.enum(["DAY", "GTC", "IOC", "OPG"]).optional()
};

export const GetOrderStatusZodShape = {
  orderId: z.string()
};

export const GetLiveOrdersZodShape = {
  accountId: z.string().optional()
};

export const ConfirmOrderZodShape = {
  replyId: z.string(),
  messageIds: z.array(z.string())
};

export const GetAlertsZodShape = {
  accountId: z.string()
};

export const CreateAlertZodShape = {
  accountId: z.string(),
  alertRequest: z.object({
    orderId: z.number().optional(),
    alertName: z.string(),
    alertMessage: z.string().optional(),
    alertRepeatable: z.number().optional(),
    expireTime: z.string().optional(),
    outsideRth: z.number().optional(),
    iTWSOrdersOnly: z.number().optional(),
    showPopup: z.number().optional(),
    toolId: z.number().optional(),
    playAudio: z.string().optional(),
    emailNotification: z.string().optional(),
    sendMessage: z.number().optional(),
    tif: z.string().optional(),
    logicBind: z.string().optional(),
    conditions: z.array(z.object({
      conidex: z.string(),
      type: z.string(),
      operator: z.string(),
      triggerMethod: z.string(),
      value: z.string(),
      logicBind: z.string().optional(),
      timeZone: z.string().optional()
    }))
  })
};

export const ActivateAlertZodShape = {
  accountId: z.string(),
  alertId: z.string()
};

export const DeleteAlertZodShape = {
  accountId: z.string(),
  alertId: z.string()
};

// Flex Query Zod Shapes
export const GetFlexQueryZodShape = {
  queryId: z.string(),
  queryName: z.string().optional(), // Optional friendly name for auto-saving
  parseXml: z.boolean().optional().default(true)
};

export const ListFlexQueriesZodShape = {
  confirm: z.literal(true)
};

export const ForgetFlexQueryZodShape = {
  queryId: z.string()
};

// Full Zod Schemas (for validation if needed)
const AuthenticateZodSchema = z.object(AuthenticateZodShape);

const GetAccountInfoZodSchema = z.object(GetAccountInfoZodShape);

export const GetPositionsZodSchema = z.object(GetPositionsZodShape);

export const GetMarketDataZodSchema = z.object(GetMarketDataZodShape);

export const PlaceOrderZodSchema = z.object(PlaceOrderZodShape).refine(
  (data) => {
    if (data.orderType === "LMT" && data.price === undefined) {
      return false;
    }
    if (data.orderType === "STP" && data.stopPrice === undefined) {
      return false;
    }
    return true;
  },
  {
    message: "LMT orders require price, STP orders require stopPrice",
    path: ["price", "stopPrice"]
  }
);

export const GetOrderStatusZodSchema = z.object(GetOrderStatusZodShape);

export const GetLiveOrdersZodSchema = z.object(GetLiveOrdersZodShape);

export const ConfirmOrderZodSchema = z.object(ConfirmOrderZodShape);

const GetAlertsZodSchema = z.object(GetAlertsZodShape);

export const CreateAlertZodSchema = z.object(CreateAlertZodShape);

export const ActivateAlertZodSchema = z.object(ActivateAlertZodShape);

export const DeleteAlertZodSchema = z.object(DeleteAlertZodShape);

// Flex Query Full Schemas
const GetFlexQueryZodSchema = z.object(GetFlexQueryZodShape);

const ListFlexQueriesZodSchema = z.object(ListFlexQueriesZodShape);

const ForgetFlexQueryZodSchema = z.object(ForgetFlexQueryZodShape);

// ── TypeScript types (inferred from Zod schemas) ────────────────────────────
export type AuthenticateInput = z.infer<typeof AuthenticateZodSchema>;
export type GetAccountInfoInput = z.infer<typeof GetAccountInfoZodSchema>;
export type GetPositionsInput = z.infer<typeof GetPositionsZodSchema>;
export type GetMarketDataInput = z.infer<typeof GetMarketDataZodSchema>;
export type PlaceOrderInput = z.infer<typeof PlaceOrderZodSchema>;
export type GetOrderStatusInput = z.infer<typeof GetOrderStatusZodSchema>;
export type GetLiveOrdersInput = z.infer<typeof GetLiveOrdersZodSchema>;
export type ConfirmOrderInput = z.infer<typeof ConfirmOrderZodSchema>;
export type GetAlertsInput = z.infer<typeof GetAlertsZodSchema>;
export type CreateAlertInput = z.infer<typeof CreateAlertZodSchema>;
export type ActivateAlertInput = z.infer<typeof ActivateAlertZodSchema>;
export type DeleteAlertInput = z.infer<typeof DeleteAlertZodSchema>;
export type GetFlexQueryInput = z.infer<typeof GetFlexQueryZodSchema>;
export type ListFlexQueriesInput = z.infer<typeof ListFlexQueriesZodSchema>;
export type ForgetFlexQueryInput = z.infer<typeof ForgetFlexQueryZodSchema>;
