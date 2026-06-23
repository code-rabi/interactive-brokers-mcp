import { Logger } from "../logger.js";
import type { IBClientRequester } from "./accounts.js";
import { AuthenticationError, isAuthenticationError } from "./types.js";

export async function getAlerts(client: IBClientRequester, accountId: string): Promise<unknown> {
  try {
    Logger.log(`[ALERT] Getting alerts for account ${accountId}`);
    const response = await client.request("GET", `/iserver/account/${accountId}/alerts`);
    Logger.log("[ALERT] Get alerts response:", response.data);
    return response.data;
  } catch (error: unknown) {
    Logger.error("[ALERT] Failed to get alerts:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to get alerts. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to get alerts: " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function createAlert(client: IBClientRequester, accountId: string, alertRequest: unknown): Promise<unknown> {
  try {
    Logger.log(`[ALERT] Creating alert for account ${accountId}:`, alertRequest);
    const response = await client.request("POST", `/iserver/account/${accountId}/alert`, { body: alertRequest });
    Logger.log("[ALERT] Alert creation response:", response.data);
    return response.data;
  } catch (error: unknown) {
    Logger.error("[ALERT] Failed to create alert:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to create alerts. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to create alert: " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function activateAlert(client: IBClientRequester, accountId: string, alertId: string): Promise<unknown> {
  try {
    Logger.log(`[ALERT] Activating alert ${alertId} for account ${accountId}`);
    const response = await client.request("POST", `/iserver/account/${accountId}/alert/activate`, { body: { alertId } });
    Logger.log("[ALERT] Alert activation response:", response.data);
    return response.data;
  } catch (error: unknown) {
    Logger.error("[ALERT] Failed to activate alert:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to activate alerts. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to activate alert: " + (error instanceof Error ? error.message : String(error)));
  }
}

export async function deleteAlert(client: IBClientRequester, accountId: string, alertId: string): Promise<unknown> {
  try {
    Logger.log(`[ALERT] Deleting alert ${alertId} for account ${accountId}`);
    const response = await client.request("DELETE", `/iserver/account/${accountId}/alert/${alertId}`);
    Logger.log("[ALERT] Alert deletion response:", response.data);
    return response.data;
  } catch (error: unknown) {
    Logger.error("[ALERT] Failed to delete alert:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError("Authentication required to delete alerts. Please authenticate with Interactive Brokers first.");
    }
    throw new Error("Failed to delete alert: " + (error instanceof Error ? error.message : String(error)));
  }
}
