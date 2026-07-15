import { HttpError } from "../http.js";

export interface AuthStatusResponse {
  authenticated?: boolean;
  connected?: boolean;
  established?: boolean;
  competing?: boolean;
  MAC?: string;
  hardware_info?: string;
}

export interface TickleResponse {
  iserver?: { authStatus?: AuthStatusResponse };
}

export interface ContractSection {
  secType?: string;
  months?: string;
  exchange?: string;
}

export interface ContractSearch {
  conid: number | string;
  symbol: string;
  description?: string;
  companyHeader?: string;
  restricted?: string | boolean;
  sections?: ContractSection[];
}

export interface OptionStrikesResponse {
  call?: number[];
  put?: number[];
}

export interface OptionContractInfo {
  conid: number | string;
  symbol: string;
  secType?: string;
  exchange?: string;
  right?: string;
  strike?: number;
  maturityDate?: string;
  multiplier?: string;
  validExchanges?: string;
  desc1?: string;
  desc2?: string;
}

export interface OrderConfirmation {
  id?: string;
  message?: string[];
  messageIds?: string[];
}

export interface OrderPayload {
  conid: number;
  orderType: string;
  side: string;
  quantity: number;
  tif: string;
  secType?: string;
  listingExchange?: string;
  price?: number;
  auxPrice?: number;
}

export interface AccountEntry {
  id?: string;
  accountId?: string;
}

export interface IBClientConfig {
  host: string;
  port: number;
}

export interface ContractLookupRequest {
  symbol?: string;
  conid?: number;
  secType?: "STK" | "OPT" | "FUND";
  expiry?: string;
  strike?: number;
  right?: "C" | "P";
  exchange?: string;
}

export interface OrderRequest extends ContractLookupRequest {
  mode: "PREVIEW" | "SUBMIT";
  accountId: string;
  action: "BUY" | "SELL";
  orderType: "MKT" | "LMT" | "STP";
  quantity?: number;
  fullPosition?: boolean;
  price?: number;
  stopPrice?: number;
  suppressConfirmations?: boolean;
  tif?: "DAY" | "GTC" | "IOC" | "OPG";
}

export interface ResolvedContract {
  conid: number;
  symbol: string;
  secType: "STK" | "OPT" | "FUND";
  contract: ContractSearch | OptionContractInfo;
  underlyingConid?: number;
}

export class AuthenticationError extends Error {
  readonly isAuthError = true;
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class SymbolNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymbolNotFoundError";
  }
}

export function isAuthenticationError(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("authentication") ||
    message.includes("authenticate") ||
    message.includes("unauthorized") ||
    message.includes("not authenticated") ||
    message.includes("login")
  ) return true;

  if (error instanceof HttpError) {
    const { status, data } = error.response;
    if (status === 401 || status === 403 || status === 500) return true;
    if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if (obj.error === "not authenticated") return true;
      if (typeof obj.error === "string" && status === 500 && obj.error.includes("authentication")) return true;
      if (typeof obj.error === "object" && obj.error !== null) {
        const nested = (obj.error as Record<string, unknown>).message;
        if (typeof nested === "string" && (nested.includes("not authenticated") || nested.includes("authentication"))) return true;
      }
    }
  }
  return false;
}
