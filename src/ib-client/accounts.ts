import { Logger } from "../logger.js";
import { isHttpError, type HttpResponse, type RequestOptions } from "../http.js";
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

interface SubaccountsPage {
  metadata?: {
    total?: number;
    pageSize?: number;
    pageNum?: number;
  };
  subaccounts?: AccountEntry[];
}

function getAccountId(account: AccountEntry): string | undefined {
  return account.id?.trim() || account.accountId?.trim() || undefined;
}

async function getPortfolioAccounts(
  client: IBClientRequester,
): Promise<AccountEntry[]> {
  const accountsResponse = await client.request<AccountEntry[]>("GET", "/portfolio/accounts");
  const primaryAccounts = Array.isArray(accountsResponse.data) ? accountsResponse.data : [];

  const accountsById = new Map<string, AccountEntry>();
  for (const account of primaryAccounts) {
    const id = getAccountId(account);
    if (id) accountsById.set(id, account);
  }

  let page = 0;
  let fetchedSubaccounts = 0;
  while (true) {
    let response: HttpResponse<SubaccountsPage>;
    try {
      response = await client.request<SubaccountsPage>(
        "GET",
        "/portfolio/subaccounts2",
        { params: { page: String(page) } },
      );
    } catch (error) {
      if (
        (isHttpError(error) && (error.response.status === 401 || error.response.status === 403))
        || (!isHttpError(error) && isAuthenticationError(error))
      ) {
        throw error;
      }
      Logger.warn(
        `[ACCOUNT-INFO] Unable to retrieve subaccounts page ${page}; returning the accounts collected so far`,
        error,
      );
      break;
    }
    const subaccounts = Array.isArray(response.data?.subaccounts)
      ? response.data.subaccounts
      : [];

    for (const account of subaccounts) {
      const id = getAccountId(account);
      if (id && !accountsById.has(id)) accountsById.set(id, account);
    }

    fetchedSubaccounts += subaccounts.length;
    const total = response.data?.metadata?.total;
    if (
      subaccounts.length === 0
      || typeof total !== "number"
      || fetchedSubaccounts >= total
    ) {
      break;
    }
    page += 1;
  }

  return [...accountsById.values()];
}

export async function getAccountInfo(
  client: IBClientRequester,
): Promise<{ accounts: unknown; summaries: Array<{ accountId: string; summary: unknown }> }> {
  Logger.log("[ACCOUNT-INFO] Starting getAccountInfo request...");
  try {
    const accounts = await getPortfolioAccounts(client);
    Logger.log(`[ACCOUNT-INFO] Found ${accounts?.length || 0} accounts:`, accounts);

    const summaries: Array<{ accountId: string; summary: unknown }> = [];
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const id = getAccountId(account);
      if (!id) {
        Logger.warn(`[ACCOUNT-INFO] Skipping account ${i + 1}/${accounts.length} without an account ID`);
        continue;
      }
      Logger.log(`[ACCOUNT-INFO] Processing account ${i + 1}/${accounts.length}: ${id}`);
      const summaryResponse = await client.request("GET", `/portfolio/${id}/summary`);
      Logger.log(`[ACCOUNT-INFO] Account ${id} summary:`, summaryResponse.data);
      summaries.push({ accountId: id, summary: summaryResponse.data });
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
