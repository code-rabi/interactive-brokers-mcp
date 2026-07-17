import { Logger } from "../logger.js";
import { HttpError } from "../http.js";
import type { IBClientRequester } from "./accounts.js";
import {
  type ContractSearch,
  type OrderPayload,
  type OrderConfirmation,
  type OrderRequest,
  AuthenticationError,
  SymbolNotFoundError,
  InvalidOrderContractError,
  isAuthenticationError,
} from "./types.js";

export class OrderSubmissionError extends Error {
  readonly status?: number;
  readonly ibkrBody?: unknown;
  readonly transportCode?: string;
  readonly submissionUncertain: boolean;

  constructor(options: {
    message: string;
    status?: number;
    ibkrBody?: unknown;
    transportCode?: string;
    submissionUncertain: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "OrderSubmissionError";
    this.status = options.status;
    Object.defineProperty(this, "ibkrBody", {
      value: options.ibkrBody,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.transportCode = options.transportCode;
    this.submissionUncertain = options.submissionUncertain;
  }
}

function isExplicitBrokerRejection(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500 || status === 408 || status === 425 || status === 429) {
    return false;
  }
  const candidates = Array.isArray(body) ? body : [body];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const value = candidate as Record<string, unknown>;
    const code = value.errorCode ?? value.error_code;
    const message = value.error ?? value.message;
    return (typeof code === "number" || (typeof code === "string" && /^\d+$/.test(code)))
      && typeof message === "string"
      && /reject|insufficient|not allowed|exceed/i.test(message);
  });
}

export interface PreparedOrder {
  accountId: string;
  order: OrderPayload;
}

async function fetchAuthoritativeContract(
  client: IBClientRequester,
  conid: number,
): Promise<ContractSearch> {
  const response = await client.request<ContractSearch>("GET", `/iserver/contract/${conid}/info`);
  const contract = response.data;
  if (!contract || Number(contract.conid) !== conid) {
    throw new InvalidOrderContractError(`Contract ${conid} returned mismatched authoritative metadata`);
  }
  return contract;
}

async function resolveAuthoritativeStock(
  client: IBClientRequester,
  conid: number,
  expectedSymbol?: string,
): Promise<ContractSearch> {
  const contract = await fetchAuthoritativeContract(client, conid);
  if (contract.secType !== "STK") {
    throw new InvalidOrderContractError(`Contract ${conid} is not an authoritative STK stock contract`);
  }
  if (contract.currency !== "USD") {
    throw new InvalidOrderContractError(`Contract ${conid} is not an authoritative USD stock contract`);
  }
  if (expectedSymbol && contract.symbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
    throw new InvalidOrderContractError(
      `Contract ${conid} symbol ${contract.symbol} does not match requested stock ${expectedSymbol}`,
    );
  }
  return contract;
}

function transportCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: { code?: unknown }; name?: unknown };
  const code = candidate.code ?? candidate.cause?.code;
  if (typeof code === "string") return code;
  return typeof candidate.name === "string" ? candidate.name : undefined;
}

async function submitOrder(
  client: IBClientRequester,
  accountId: string,
  order: OrderPayload,
): Promise<unknown> {
  try {
    const response = await client.request<OrderConfirmation[]>(
      "POST",
      `/iserver/account/${accountId}/orders`,
      { body: { orders: [order] } },
    );
    return response.data;
  } catch (error) {
    if (error instanceof HttpError) {
      const definiteRejection = isExplicitBrokerRejection(error.response.status, error.response.data);
      throw new OrderSubmissionError({
        message: definiteRejection
          ? `IBKR explicitly rejected order submission with HTTP status ${error.response.status}`
          : `Order submission outcome is uncertain after HTTP status ${error.response.status}`,
        status: error.response.status,
        ibkrBody: error.response.data,
        submissionUncertain: !definiteRejection,
        cause: error,
      });
    }
    throw new OrderSubmissionError({
      message: "Order submission outcome is uncertain because the transport failed before a response was received",
      transportCode: transportCode(error),
      submissionUncertain: true,
      cause: error,
    });
  }
}

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

export async function prepareOrder(
  client: IBClientRequester,
  orderRequest: OrderRequest,
): Promise<PreparedOrder> {
  if (orderRequest.conid !== undefined) {
    const contract = await resolveAuthoritativeStock(client, orderRequest.conid, orderRequest.symbol);
    const order: OrderPayload = {
        conid: Number(contract.conid),
        cOID: orderRequest.clientOrderId,
        orderType: orderRequest.orderType,
        side: orderRequest.action,
        quantity: Number(orderRequest.quantity),
        price: Number(orderRequest.price),
        tif: orderRequest.tif || "DAY",
    };
    if (orderRequest.exchange) order.exchange = orderRequest.exchange;
    return { accountId: orderRequest.accountId, order };
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

  const candidateConids = [...new Set(searchResponse.data.map((candidate) => Number(candidate.conid)))];
  const authoritativeCandidates = await Promise.all(
    candidateConids.map((conid) => fetchAuthoritativeContract(client, conid)),
  );
  const stockCandidates = authoritativeCandidates.filter(
    (candidate) => candidate.secType === "STK"
      && candidate.currency === "USD"
      && candidate.symbol.toUpperCase() === orderRequest.symbol!.toUpperCase(),
  );
  if (stockCandidates.length !== 1) {
    const reason = stockCandidates.length === 0 ? "no eligible USD STK stock contract" : "ambiguous eligible USD STK stock contracts";
    throw new InvalidOrderContractError(`Symbol ${orderRequest.symbol} resolved to ${reason}`);
  }

  const contract = stockCandidates[0];
  const order: OrderPayload = {
      conid: Number(contract.conid),
      cOID: orderRequest.clientOrderId,
      orderType: orderRequest.orderType,
      side: orderRequest.action,
      quantity: Number(orderRequest.quantity),
      price: Number(orderRequest.price),
      tif: orderRequest.tif || "DAY",
  };
  if (orderRequest.exchange) order.exchange = orderRequest.exchange;
  return { accountId: orderRequest.accountId, order };
}

export async function submitPreparedOrder(
  client: IBClientRequester,
  prepared: PreparedOrder,
): Promise<unknown> {
  return submitOrder(client, prepared.accountId, prepared.order);
}

export async function placeOrder(client: IBClientRequester, orderRequest: OrderRequest): Promise<unknown> {
  try {
    const prepared = await prepareOrder(client, orderRequest);
    return await submitPreparedOrder(client, prepared);
  } catch (error: unknown) {
    if (error instanceof OrderSubmissionError) {
      Logger.error("Failed to place order:", {
        name: error.name,
        status: error.status,
        transportCode: error.transportCode,
        submissionUncertain: error.submissionUncertain,
      });
    } else {
      Logger.error("Failed to place order:", error);
    }
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to place orders. Please authenticate with Interactive Brokers first.");
    }
    if (error instanceof SymbolNotFoundError) throw error;
    if (error instanceof InvalidOrderContractError) throw error;
    if (error instanceof OrderSubmissionError) throw error;
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
