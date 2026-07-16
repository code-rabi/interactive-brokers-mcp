import { PlaceOrderZodSchema, type PlaceOrderInput } from "./tool-definitions.js";
import { parseReadOnlyMode } from "./config.js";

export interface OrderPolicyConfig {
  IB_READ_ONLY_MODE?: boolean | string;
  IB_ALLOWED_ACCOUNT_ID?: string;
}

export class OrderPolicy {
  readonly readOnly: boolean;
  private readonly allowedAccountId?: string;

  constructor(config: OrderPolicyConfig) {
    this.readOnly = parseReadOnlyMode(config.IB_READ_ONLY_MODE);
    this.allowedAccountId = config.IB_ALLOWED_ACCOUNT_ID?.trim() || undefined;
  }

  assertWriteEnabled(): void {
    if (this.readOnly) {
      throw new Error("Write operations are disabled in read-only mode");
    }
    if (!this.allowedAccountId) {
      throw new Error("IB_ALLOWED_ACCOUNT_ID is required when IB_READ_ONLY_MODE is false");
    }
  }

  assertAllowedAccount(accountId: string): void {
    this.assertWriteEnabled();
    if (accountId !== this.allowedAccountId) {
      throw new Error(`Write operation account must match IB_ALLOWED_ACCOUNT_ID (${this.allowedAccountId})`);
    }
  }

  validatePlaceOrder(input: unknown): PlaceOrderInput {
    const order = PlaceOrderZodSchema.parse(input);
    if (!order.symbol && order.conid === undefined) {
      throw new Error("Either symbol or conid is required");
    }
    this.assertAllowedAccount(order.accountId);
    return order;
  }
}
