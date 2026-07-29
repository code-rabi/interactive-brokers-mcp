import { Logger } from "../logger.js";
import type { IBClientRequester } from "./accounts.js";
import { resolveContract } from "./options.js";
import { searchContracts } from "./market-data.js";
import {
  type ContractSearch,
  type OrderPayload,
  type OrderConfirmation,
  type OrderRequest,
  type SecurityType,
  AuthenticationError,
  SymbolNotFoundError,
  isAuthenticationError,
} from "./types.js";

function normalizeAccountId(account: unknown): string | undefined {
  if (!account) return undefined;
  if (typeof account === "string") return account.trim() || undefined;
  if (typeof account === "object" && account !== null) {
    const obj = account as Record<string, unknown>;
    const id = obj.id ?? obj.accountId ?? obj.account_id ?? obj.acctId ?? obj.account;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  }
  return undefined;
}

function extractAccountIds(data: unknown): string[] {
  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
  const candidates: unknown[] = [
    ...(Array.isArray(data) ? data : []),
    ...(Array.isArray(obj?.accounts) ? (obj.accounts as unknown[]) : []),
    ...(Array.isArray(obj?.accountIds) ? (obj.accountIds as unknown[]) : []),
    obj?.selectedAccount,
    obj?.selected_account,
  ];
  return [...new Set(
    candidates.map((a) => normalizeAccountId(a)).filter((id): id is string => Boolean(id)),
  )];
}

function extractOrders(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as unknown[];
  }
  return [];
}

async function getOrderAccountIds(client: IBClientRequester): Promise<string[]> {
  const sources = [
    { label: "/iserver/accounts", fetch: () => client.request("GET", "/iserver/accounts") },
    { label: "/portfolio/accounts", fetch: () => client.request("GET", "/portfolio/accounts") },
  ];
  for (const source of sources) {
    try {
      const response = await source.fetch();
      const ids = extractAccountIds(response.data);
      if (ids.length > 0) return ids;
    } catch (error) {
      Logger.warn(`[ORDERS] Failed to discover accounts via ${source.label}:`, error);
    }
  }
  return [];
}

export async function placeOrder(
  client: IBClientRequester,
  orderRequest: Omit<OrderRequest, "mode">,
): Promise<unknown> {
  return order(client, { ...orderRequest, mode: "SUBMIT" });
}

function contractSupportsFund(contract: ContractSearch, exchange: string): boolean {
  const targetExchange = exchange.toUpperCase();
  const matchingSection = contract.sections?.some((section) =>
    section.secType === "FUND"
    && (!section.exchange || section.exchange.toUpperCase().split(";").includes(targetExchange))
  ) ?? false;
  const topLevelFund = typeof contract.restricted === "string"
    && contract.restricted.toUpperCase() === "FUND";
  const topLevelExchange = [contract.description, contract.companyHeader]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toUpperCase().includes(targetExchange));
  return matchingSection || (topLevelFund && topLevelExchange);
}

async function resolveOrderContract(
  client: IBClientRequester,
  orderRequest: OrderRequest,
): Promise<{ conid: number; secType: SecurityType }> {
  if (orderRequest.secType !== "FUND" || orderRequest.conid !== undefined) {
    const contract = await resolveContract(client, orderRequest);
    return { conid: contract.conid, secType: contract.secType };
  }

  if (!orderRequest.symbol) {
    throw new Error("FUND orders require symbol or conid");
  }

  const listingExchange = orderRequest.exchange || "FUNDSERV";
  const contracts = await searchContracts(client, orderRequest.symbol);
  const contract = contracts.find((candidate) => contractSupportsFund(candidate, listingExchange));
  if (!contract) {
    throw new SymbolNotFoundError(
      `Mutual fund ${orderRequest.symbol} on ${listingExchange} not found`,
    );
  }

  return { conid: Number(contract.conid), secType: "FUND" };
}

function conidFromConidex(conidex: string | undefined): number | undefined {
  const match = conidex?.match(/^(\d+)/);
  if (!match) return undefined;
  const conid = Number(match[1]);
  return Number.isSafeInteger(conid) && conid > 0 ? conid : undefined;
}

function positionEntries(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null
    );
  }
  if (typeof data === "object" && data !== null) {
    const object = data as Record<string, unknown>;
    if (Array.isArray(object.positions)) {
      return object.positions.filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null
      );
    }
    return [object];
  }
  return [];
}

async function resolveFullPositionQuantity(
  client: IBClientRequester,
  accountId: string,
  conid: number,
  action: "BUY" | "SELL",
): Promise<number> {
  const response = await client.request(
    "GET",
    `/portfolio/${accountId}/position/${conid}`,
  );
  const positions = positionEntries(response.data)
    .filter((entry) => Number(entry.conid) === conid)
    .map((entry) => Number(entry.position))
    .filter(Number.isFinite);
  const position = positions.reduce((total, value) => total + value, 0);

  if (position === 0) {
    throw new Error(`No open position found for conid ${conid} in account ${accountId}`);
  }
  if ((position > 0 && action !== "SELL") || (position < 0 && action !== "BUY")) {
    const closingAction = position > 0 ? "SELL" : "BUY";
    throw new Error(
      `fullPosition for conid ${conid} must use action ${closingAction} to close position ${position}`,
    );
  }

  return Math.abs(position);
}

interface BuiltOrderPayload {
  payload: OrderPayload;
  referenceConid?: number;
}

async function buildOrderPayload(
  client: IBClientRequester,
  orderRequest: OrderRequest,
): Promise<BuiltOrderPayload> {
  const secType = orderRequest.secType || "STK";
  if (orderRequest.conidex && secType !== "BAG" && secType !== "CRYPTO") {
    throw new Error("conidex is only supported for BAG and CRYPTO orders");
  }

  const contract = (secType === "BAG" || secType === "CRYPTO") && orderRequest.conidex
    ? undefined
    : await resolveOrderContract(client, orderRequest);
  const referenceConid = contract?.conid
    ?? (secType === "CRYPTO" ? conidFromConidex(orderRequest.conidex) : undefined);
  const sizeFieldCount = [
    orderRequest.quantity !== undefined,
    orderRequest.cashQuantity !== undefined,
    orderRequest.fullPosition === true,
  ].filter(Boolean).length;
  if (sizeFieldCount !== 1) {
    throw new Error("Exactly one of quantity, cashQuantity, or fullPosition must be provided");
  }
  const quantity = orderRequest.fullPosition
    ? referenceConid === undefined
      ? undefined
      : await resolveFullPositionQuantity(
        client,
        orderRequest.accountId,
        referenceConid,
        orderRequest.action,
      )
    : orderRequest.quantity === undefined ? undefined : Number(orderRequest.quantity);
  const cashQuantity = orderRequest.cashQuantity === undefined
    ? undefined
    : Number(orderRequest.cashQuantity);

  if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) {
    throw new Error("Order quantity must be a positive number");
  }
  if (cashQuantity !== undefined && (!Number.isFinite(cashQuantity) || cashQuantity <= 0)) {
    throw new Error("Order cashQuantity must be a positive number");
  }
  if (quantity === undefined && cashQuantity === undefined) {
    throw new Error("Order requires quantity, cashQuantity, or a resolvable full position");
  }
  if (
    secType === "CRYPTO"
    && orderRequest.action === "BUY"
    && orderRequest.orderType === "MKT"
    && cashQuantity === undefined
  ) {
    throw new Error("CRYPTO market buys require cashQuantity");
  }

  const orderPayload: OrderPayload = {
    orderType: orderRequest.orderType,
    side: orderRequest.action,
    tif: orderRequest.tif || "DAY",
  };
  if (quantity !== undefined) orderPayload.quantity = quantity;
  if (cashQuantity !== undefined) orderPayload.cashQty = cashQuantity;

  if (secType === "BAG") {
    if (!orderRequest.conidex) {
      throw new Error("BAG orders require the full combo composition in conidex");
    }
    orderPayload.conidex = orderRequest.conidex;
  } else if (secType === "CRYPTO") {
    const conidex = orderRequest.conidex
      ?? (contract && orderRequest.exchange
        ? `${contract.conid}@${orderRequest.exchange}`
        : undefined);
    if (!conidex || !conidex.includes("@")) {
      throw new Error("CRYPTO orders require an exchange-qualified conidex or conid plus exchange");
    }
    orderPayload.conidex = conidex;
    if (orderRequest.orderType === "MKT") orderPayload.tif = "IOC";
  } else {
    // All non-BAG/CRYPTO paths resolve a concrete contract above.
    orderPayload.conid = contract!.conid;
  }

  if (orderRequest.secType && contract) {
    orderPayload.secType = `${contract.conid}:${contract.secType}`;
  }
  const listingExchange = orderRequest.exchange
    || (contract?.secType === "FUND" ? "FUNDSERV" : undefined);
  if (listingExchange && secType !== "CRYPTO") orderPayload.listingExchange = listingExchange;
  if (orderRequest.orderType === "LMT" && orderRequest.price !== undefined) {
    orderPayload.price = Number(orderRequest.price);
  }
  if (orderRequest.orderType === "STP" && orderRequest.stopPrice !== undefined) {
    orderPayload.auxPrice = Number(orderRequest.stopPrice);
  }

  return { payload: orderPayload, referenceConid };
}

export async function order(client: IBClientRequester, orderRequest: OrderRequest): Promise<unknown> {
  try {
    const builtOrder = await buildOrderPayload(client, orderRequest);
    const orderPayload = builtOrder.payload;
    const body = { orders: [orderPayload] };
    const endpoint = orderRequest.mode === "PREVIEW"
      ? `/iserver/account/${orderRequest.accountId}/orders/whatif`
      : `/iserver/account/${orderRequest.accountId}/orders`;

    if (orderRequest.mode === "PREVIEW" && builtOrder.referenceConid !== undefined) {
      await client.request("GET", "/iserver/marketdata/snapshot", {
        params: { conids: String(builtOrder.referenceConid), fields: "31" },
      });
    }

    const response = await client.request<unknown>(
      "POST",
      endpoint,
      { body },
    );

    if (orderRequest.mode === "SUBMIT" && Array.isArray(response.data) && response.data.length > 0) {
      const first = response.data[0] as OrderConfirmation;
      if (first.id && first.message && first.messageIds && orderRequest.suppressConfirmations) {
        Logger.log("Order confirmation received, automatically confirming", first);
        return await confirmOrder(client, first.id, first.messageIds);
      }
    }
    return response.data;
  } catch (error: unknown) {
    Logger.error(`Failed to ${orderRequest.mode.toLowerCase()} order:`, error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(
        `Authentication required to ${orderRequest.mode.toLowerCase()} orders. Please authenticate with Interactive Brokers first.`,
      );
    }
    if (error instanceof SymbolNotFoundError) throw error;
    if (error instanceof Error) throw error;
    throw new Error(`Failed to ${orderRequest.mode.toLowerCase()} order`, { cause: error });
  }
}

export async function confirmOrder(client: IBClientRequester, replyId: string, messageIds: string[]): Promise<unknown> {
  try {
    Logger.log(`Confirming order with reply ID ${replyId} and message IDs:`, messageIds);
    const response = await client.request("POST", `/iserver/reply/${replyId}`, {
      body: { confirmed: true, messageIds },
    });
    Logger.log("Order confirmation response:", response.data);
    return response.data;
  } catch (error: unknown) {
    Logger.error("Failed to confirm order:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to confirm orders. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to confirm order: " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function getOrderStatus(client: IBClientRequester, orderId: string): Promise<unknown> {
  try {
    const response = await client.request("GET", `/iserver/account/orders/${orderId}`);
    return response.data;
  } catch (error: unknown) {
    Logger.error("Failed to get order status:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(`Authentication required to get order status for order ${orderId}. Please authenticate with Interactive Brokers first.`);
    }
    throw new Error(`Failed to get status for order ${orderId}`);
  }
}

export async function getOrders(client: IBClientRequester, accountId?: string): Promise<unknown> {
  try {
    const url = "/iserver/account/orders";
    if (accountId) {
      const response = await client.request("GET", url, { params: { accountId } });
      return response.data;
    }

    const accountIds = await getOrderAccountIds(client);
    if (accountIds.length === 0) {
      Logger.warn("[ORDERS] Could not discover account IDs; falling back to unscoped orders request");
      const response = await client.request("GET", url);
      return response.data;
    }

    const accountResults: Array<{ accountId: string; data: unknown }> = [];
    const orders: unknown[] = [];
    for (const id of accountIds) {
      const response = await client.request("GET", url, { params: { accountId: id } });
      accountResults.push({ accountId: id, data: response.data });
      orders.push(...extractOrders(response.data));
    }
    return { orders, accountResults };
  } catch (error: unknown) {
    Logger.error("Failed to get orders:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to retrieve orders. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to retrieve orders");
  }
}
