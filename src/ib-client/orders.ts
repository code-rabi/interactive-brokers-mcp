import { Logger } from "../logger.js";
import type { IBClientRequester } from "./accounts.js";
import { resolveContract } from "./options.js";
import {
  type ContractSearch,
  type OrderPayload,
  type OrderConfirmation,
  type OrderRequest,
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

export async function placeOrder(client: IBClientRequester, orderRequest: OrderRequest): Promise<unknown> {
  try {
    if (orderRequest.conid !== undefined || orderRequest.secType === "OPT") {
      const contract = await resolveContract(client, orderRequest);
      const order: OrderPayload = {
        conid: contract.conid,
        orderType: orderRequest.orderType,
        side: orderRequest.action,
        quantity: Number(orderRequest.quantity),
        tif: orderRequest.tif || "DAY",
      };

      if (orderRequest.exchange) order.exchange = orderRequest.exchange;
      if (contract.secType === "OPT" || orderRequest.secType === "OPT") order.secType = "OPT";
      if (orderRequest.orderType === "LMT" && orderRequest.price !== undefined) {
        order.price = Number(orderRequest.price);
      }
      if (orderRequest.orderType === "STP" && orderRequest.stopPrice !== undefined) {
        order.auxPrice = Number(orderRequest.stopPrice);
      }

      const response = await client.request<OrderConfirmation[]>(
        "POST",
        `/iserver/account/${orderRequest.accountId}/orders`,
        { body: { orders: [order] } },
      );

      if (Array.isArray(response.data) && response.data.length > 0) {
        const first = response.data[0];
        if (first.id && first.message && first.messageIds && orderRequest.suppressConfirmations) {
          Logger.log("Order confirmation received, auto-confirming", first);
          return await confirmOrder(client, first.id, first.messageIds);
        }
      }

      return response.data;
    }

    if (!orderRequest.symbol) {
      throw new Error("Symbol is required when conid is not provided");
    }

    let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(orderRequest.symbol)}`;
    if (orderRequest.exchange) searchUrl += `&name=${encodeURIComponent(orderRequest.exchange)}`;
    const searchResponse = await client.request<ContractSearch[]>("GET", searchUrl);

    if (!searchResponse.data || searchResponse.data.length === 0) {
      throw new SymbolNotFoundError(`Symbol ${orderRequest.symbol}${orderRequest.exchange ? " on " + orderRequest.exchange : ""} not found`);
    }

    const contract = searchResponse.data[0];
    const order: OrderPayload = {
      conid: Number(contract.conid),
      orderType: orderRequest.orderType,
      side: orderRequest.action,
      quantity: Number(orderRequest.quantity),
      tif: orderRequest.tif || "DAY",
    };
    if (orderRequest.exchange) order.exchange = orderRequest.exchange;
    if (orderRequest.orderType === "LMT" && orderRequest.price !== undefined) order.price = Number(orderRequest.price);
    if (orderRequest.orderType === "STP" && orderRequest.stopPrice !== undefined) order.auxPrice = Number(orderRequest.stopPrice);

    const response = await client.request<OrderConfirmation[]>("POST",
      `/iserver/account/${orderRequest.accountId}/orders`,
      { body: { orders: [order] } },
    );

    if (Array.isArray(response.data) && response.data.length > 0) {
      const first = response.data[0];
      if (first.id && first.message && first.messageIds && orderRequest.suppressConfirmations) {
        Logger.log("Order confirmation received, automatically confirming...", first);
        return await confirmOrder(client, first.id, first.messageIds);
      }
    }
    return response.data;
  } catch (error: unknown) {
    Logger.error("Failed to place order:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to place orders. Please authenticate with Interactive Brokers first.");
    }
    if (error instanceof SymbolNotFoundError) throw error;
    throw new Error("Failed to place order");
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
