import { Logger } from "../logger.js";
import type { HttpResponse, RequestOptions } from "../http.js";
import {
  type AccountEntry,
  AuthenticationError,
  isAuthenticationError,
} from "./types.js";

export interface IBClientRequester {
  request<T = unknown>(
    method: string,
    urlPath: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>>;
}

export async function getAccountInfo(
  client: IBClientRequester,
): Promise<{ accounts: unknown; summaries: Array<{ accountId: string; summary: unknown }> }> {
  Logger.log("[ACCOUNT-INFO] Starting getAccountInfo request...");
  try {
    const accountsResponse = await client.request<AccountEntry[]>("GET", "/portfolio/accounts");
    const accounts = accountsResponse.data;
    Logger.log(`[ACCOUNT-INFO] Found ${accounts?.length || 0} accounts:`, accounts);

    const summaries: Array<{ accountId: string; summary: unknown }> = [];
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      Logger.log(`[ACCOUNT-INFO] Processing account ${i + 1}/${accounts.length}: ${account.id}`);
      const summaryResponse = await client.request("GET", `/portfolio/${account.id}/summary`);
      Logger.log(`[ACCOUNT-INFO] Account ${account.id} summary:`, summaryResponse.data);
      summaries.push({ accountId: account.id!, summary: summaryResponse.data });
    }

    Logger.log(`[ACCOUNT-INFO] Completed processing ${summaries.length} accounts`);
    return { accounts, summaries };
  } catch (error: unknown) {
    Logger.error("[ACCOUNT-INFO] Failed to get account info:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to retrieve account information. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to retrieve account information");
  }
}

export async function getPositions(
  client: IBClientRequester,
  accountId?: string,
): Promise<unknown> {
  try {
    const url = accountId ? `/portfolio/${accountId}/positions` : "/portfolio/positions";
    const response = await client.request("GET", url);
    return response.data;
  } catch (error: unknown) {
    Logger.error("Failed to get positions:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to retrieve positions. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to retrieve positions");
  }
}
