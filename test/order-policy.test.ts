import { describe, expect, it } from "vitest";
import { OrderPolicy } from "../src/order-policy.js";

const validOrder = {
  clientOrderId: "codex-20260716-001",
  accountId: "U12345",
  symbol: "AAPL",
  action: "BUY" as const,
  orderType: "LMT" as const,
  quantity: 2,
  price: 185.5,
};

describe("OrderPolicy", () => {
  it("treats omitted and non-false values as read-only", () => {
    expect(() => new OrderPolicy({}).assertWriteEnabled()).toThrow(/read-only/i);
    expect(() => new OrderPolicy({ IB_READ_ONLY_MODE: "False" }).assertWriteEnabled()).toThrow(/read-only/i);
    expect(() => new OrderPolicy({ IB_READ_ONLY_MODE: true }).assertWriteEnabled()).toThrow(/read-only/i);
  });

  it.each([false, "false"])("allows explicit %j only with an account allowlist", (value) => {
    expect(() => new OrderPolicy({ IB_READ_ONLY_MODE: value }).assertWriteEnabled())
      .toThrow(/IB_ALLOWED_ACCOUNT_ID/);
    expect(() => new OrderPolicy({
      IB_READ_ONLY_MODE: value,
      IB_ALLOWED_ACCOUNT_ID: "U12345",
    }).assertWriteEnabled()).not.toThrow();
  });

  it("rejects an account other than the allowlisted account", () => {
    const policy = new OrderPolicy({ IB_READ_ONLY_MODE: false, IB_ALLOWED_ACCOUNT_ID: "U12345" });
    expect(() => policy.assertAllowedAccount("U99999")).toThrow(/U12345/);
  });

  it("accepts a valid limit stock order", () => {
    const policy = new OrderPolicy({ IB_READ_ONLY_MODE: false, IB_ALLOWED_ACCOUNT_ID: "U12345" });
    expect(() => policy.validatePlaceOrder(validOrder)).not.toThrow();
  });

  it("requires either symbol or conid", () => {
    const policy = new OrderPolicy({ IB_READ_ONLY_MODE: false, IB_ALLOWED_ACCOUNT_ID: "U12345" });
    expect(() => policy.validatePlaceOrder({ ...validOrder, symbol: undefined })).toThrow(/symbol or conid/i);
  });

  it.each([
    ["market order", { orderType: "MKT" }],
    ["stop order", { orderType: "STP", stopPrice: 180 }],
    ["option secType", { secType: "OPT" }],
    ["option expiry", { expiry: "JAN27" }],
    ["option strike", { strike: 200 }],
    ["option right", { right: "C" }],
    ["suppressed confirmations", { suppressConfirmations: true }],
    ["missing price", { price: undefined }],
    ["zero price", { price: 0 }],
    ["nonfinite price", { price: Number.POSITIVE_INFINITY }],
    ["zero quantity", { quantity: 0 }],
    ["nonfinite quantity", { quantity: Number.NaN }],
    ["blank client order id", { clientOrderId: "   " }],
  ])("rejects %s", (_label, override) => {
    const policy = new OrderPolicy({ IB_READ_ONLY_MODE: false, IB_ALLOWED_ACCOUNT_ID: "U12345" });
    expect(() => policy.validatePlaceOrder({ ...validOrder, ...override })).toThrow();
  });
});
