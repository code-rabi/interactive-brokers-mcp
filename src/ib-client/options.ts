import { Logger } from "../logger.js";
import type { IBClientRequester } from "./accounts.js";
import { searchContracts, pickContract } from "./market-data.js";
import {
  type ContractSearch,
  type OptionContractInfo,
  type OptionStrikesResponse,
  type ResolvedContract,
  type ContractLookupRequest,
  AuthenticationError,
  SymbolNotFoundError,
  isAuthenticationError,
} from "./types.js";

function getOptionMonths(contract: ContractSearch): string[] {
  const months = contract.sections
    ?.filter((section) => section.secType === "OPT" && typeof section.months === "string")
    .flatMap((section) => section.months!.split(";"))
    .map((month) => month.trim())
    .filter(Boolean) ?? [];

  return [...new Set(months)];
}

function buildOptionStrikesUrl(underlyingConid: number, expiry: string, exchange?: string): string {
  const params = new URLSearchParams({
    conid: String(underlyingConid),
    secType: "OPT",
    month: expiry.toUpperCase(),
  });

  if (exchange) {
    params.set("exchange", exchange);
  }

  return `/iserver/secdef/strikes?${params.toString()}`;
}

function buildOptionInfoUrl(
  underlyingConid: number,
  expiry: string,
  strike: number,
  right: "C" | "P",
  exchange?: string,
): string {
  const params = new URLSearchParams({
    conid: String(underlyingConid),
    secType: "OPT",
    month: expiry.toUpperCase(),
    strike: String(strike),
    right,
  });

  if (exchange) {
    params.set("exchange", exchange);
  }

  return `/iserver/secdef/info?${params.toString()}`;
}

async function resolveUnderlyingContract(
  client: IBClientRequester,
  symbol: string,
  exchange?: string,
): Promise<ResolvedContract> {
  const contracts = await searchContracts(client, symbol);
  const contract = pickContract(contracts, exchange);

  return {
    conid: Number(contract.conid),
    symbol: contract.symbol,
    secType: "STK",
    contract,
  };
}

async function resolveOptionContract(
  client: IBClientRequester,
  request: ContractLookupRequest,
): Promise<ResolvedContract> {
  if (!request.symbol || !request.expiry || request.strike === undefined || !request.right) {
    throw new Error("Option contract resolution requires symbol, expiry, strike, and right");
  }

  const underlying = await resolveUnderlyingContract(client, request.symbol, request.exchange);
  const response = await client.request<OptionContractInfo[]>(
    "GET",
    buildOptionInfoUrl(
      underlying.conid,
      request.expiry,
      Number(request.strike),
      request.right,
      request.exchange,
    ),
  );

  if (!response.data || response.data.length === 0) {
    throw new SymbolNotFoundError(
      `Option ${request.symbol} ${request.expiry} ${request.strike} ${request.right} not found`,
    );
  }

  const contract = pickContract(response.data, request.exchange);

  return {
    conid: Number(contract.conid),
    symbol: contract.symbol || request.symbol,
    secType: "OPT",
    contract,
    underlyingConid: underlying.conid,
  };
}

export async function resolveContract(
  client: IBClientRequester,
  request: ContractLookupRequest,
): Promise<ResolvedContract> {
  if (request.conid !== undefined) {
    return {
      conid: Number(request.conid),
      symbol: request.symbol || String(request.conid),
      secType: request.secType || "STK",
      contract: {
        conid: Number(request.conid),
        symbol: request.symbol || String(request.conid),
      },
    };
  }

  if (request.secType === "OPT") {
    return resolveOptionContract(client, request);
  }

  if (request.secType && request.secType !== "STK") {
    throw new Error(
      `${request.secType} contract resolution requires conid; symbol resolution is only supported for STK, OPT, and FUND`,
    );
  }

  if (!request.symbol) {
    throw new Error("Symbol is required when conid is not provided");
  }

  return resolveUnderlyingContract(client, request.symbol, request.exchange);
}

export async function getOptionChain(
  client: IBClientRequester,
  symbol: string,
  exchange?: string,
): Promise<{
  symbol: string;
  underlyingConid: number;
  expirations: Array<{ expiry: string; call: number[]; put: number[] }>;
}> {
  try {
    const underlying = await resolveUnderlyingContract(client, symbol, exchange);
    const expirations = getOptionMonths(underlying.contract as ContractSearch);
    const batchSize = 3;
    const optionChain: Array<{
      expiry: string;
      call: number[];
      put: number[];
    }> = [];

    for (let index = 0; index < expirations.length; index += batchSize) {
      const batch = expirations.slice(index, index + batchSize);
      const resolvedBatch = await Promise.all(
        batch.map(async (expiry) => {
          const response = await client.request<OptionStrikesResponse>(
            "GET",
            buildOptionStrikesUrl(underlying.conid, expiry, exchange),
          );

          return {
            expiry,
            call: Array.isArray(response.data?.call) ? response.data.call : [],
            put: Array.isArray(response.data?.put) ? response.data.put : [],
          };
        }),
      );

      optionChain.push(...resolvedBatch);
    }

    return {
      symbol: underlying.symbol,
      underlyingConid: underlying.conid,
      expirations: optionChain,
    };
  } catch (error: unknown) {
    Logger.error("Failed to get option chain:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(
        "Authentication required to get option chain. Please authenticate with Interactive Brokers first.",
      );
    }
    if (error instanceof SymbolNotFoundError) throw error;
    throw new Error(`Failed to get option chain for ${symbol}`);
  }
}

export async function resolveOptionConid(
  client: IBClientRequester,
  symbol: string,
  expiry: string,
  strike: number,
  right: "C" | "P",
  exchange?: string,
): Promise<{
  symbol: string;
  underlyingConid: number;
  option: OptionContractInfo;
}> {
  try {
    const resolved = await resolveOptionContract(client, {
      symbol,
      expiry,
      strike,
      right,
      exchange,
    });

    return {
      symbol: resolved.symbol,
      underlyingConid: resolved.underlyingConid!,
      option: resolved.contract as OptionContractInfo,
    };
  } catch (error: unknown) {
    Logger.error("Failed to resolve option conid:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(
        "Authentication required to resolve option contracts. Please authenticate with Interactive Brokers first.",
      );
    }
    if (error instanceof SymbolNotFoundError) throw error;
    throw new Error(`Failed to resolve option conid for ${symbol} ${expiry} ${strike} ${right}`);
  }
}
