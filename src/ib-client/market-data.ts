import { Logger } from "../logger.js";
import type { IBClientRequester } from "./accounts.js";
import {
  type ContractSearch,
  type OptionContractInfo,
  AuthenticationError,
  SymbolNotFoundError,
  isAuthenticationError,
} from "./types.js";

export function matchesExchange(contract: ContractSearch | OptionContractInfo, exchange?: string): boolean {
  if (!exchange) return true;

  const target = exchange.toUpperCase();
  const values = [
    "exchange" in contract ? contract.exchange : undefined,
    "validExchanges" in contract ? contract.validExchanges : undefined,
    "description" in contract ? contract.description : undefined,
    "companyHeader" in contract ? contract.companyHeader : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toUpperCase());

  return values.some((value) => value.includes(target));
}

export function pickContract<T extends ContractSearch | OptionContractInfo>(
  contracts: T[],
  exchange?: string,
): T {
  const match = contracts.find((contract) => matchesExchange(contract, exchange));
  return match ?? contracts[0];
}

export async function searchContracts(client: IBClientRequester, symbol: string): Promise<ContractSearch[]> {
  const response = await client.request<ContractSearch[]>(
    "GET",
    `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`,
  );

  if (!response.data || response.data.length === 0) {
    throw new SymbolNotFoundError(`Symbol ${symbol} not found`);
  }

  return response.data;
}

export async function getMarketData(
  client: IBClientRequester,
  symbol: string,
  exchange?: string,
): Promise<{ symbol: string; contract: ContractSearch; marketData: unknown }> {
  try {
    let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`;
    if (exchange) searchUrl += `&name=${encodeURIComponent(exchange)}`;
    const searchResponse = await client.request<ContractSearch[]>("GET", searchUrl);

    if (!searchResponse.data || searchResponse.data.length === 0) {
      throw new SymbolNotFoundError(`Symbol ${symbol}${exchange ? " on " + exchange : ""} not found`);
    }

    const contract = searchResponse.data[0];
    const response = await client.request("GET",
      `/iserver/marketdata/snapshot?conids=${contract.conid}&fields=31,70,71,82,83,84,85,86,87,88`,
    );
    return { symbol, contract, marketData: response.data };
  } catch (error: unknown) {
    Logger.error("Failed to get market data:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(`Authentication required to retrieve market data for ${symbol}. Please authenticate with Interactive Brokers first.`);
    }
    if (error instanceof SymbolNotFoundError) throw error;
    throw new Error(`Failed to retrieve market data for ${symbol}`);
  }
}
