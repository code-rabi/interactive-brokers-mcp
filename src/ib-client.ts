import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Agent } from "undici";
import { Logger } from "./logger.js";
import {
  HttpClient,
  HttpError,
  type HttpResponse,
  type RequestOptions,
} from "./http.js";

import { getAccountInfo, getPositions } from "./ib-client/accounts.js";
import { getMarketData } from "./ib-client/market-data.js";
import { getOptionChain, resolveOptionConid } from "./ib-client/options.js";
import {
  placeOrder,
  prepareOrder,
  submitPreparedOrder,
  confirmOrder,
  getOrderStatus,
  getOrders,
  OrderSubmissionError,
  type PreparedOrder,
} from "./ib-client/orders.js";
import { getAlerts, createAlert, activateAlert, deleteAlert } from "./ib-client/alerts.js";
import {
  type AuthStatusResponse,
  type ContractSearch,
  type IBClientConfig,
  type OptionContractInfo,
  type OrderRequest,
  type TickleResponse,
  SymbolNotFoundError,
  InvalidOrderContractError,
} from "./ib-client/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKLER_COOKIE_ENV = "IB_TICKLER_COOKIE_HEADER";

export { SymbolNotFoundError, InvalidOrderContractError, OrderSubmissionError };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class IBClient {
  private baseUrl!: string;
  private client!: HttpClient;
  private config: IBClientConfig;
  private isAuthenticated = false;
  private authAttempts = 0;
  private maxAuthAttempts = 3;
  private tickleInterval?: NodeJS.Timeout;
  private tickleIntervalMs = 30000;
  private tickleFailures = 0;
  private maxTickleFailures = 10;
  private sessionCookieHeader?: string;
  private runtimeDir = path.join(__dirname, "../ib-gateway/.runtime");
  private ticklerJsonPath = path.join(this.runtimeDir, "tickler-session.json");
  private ticklerScriptPath = path.join(__dirname, "scripts/tickler.js");

  constructor(config: IBClientConfig) {
    this.config = config;
    this.initializeClient();
  }

  private initializeClient(): void {
    this.baseUrl = `https://${this.config.host}:${this.config.port}/v1/api`;
    this.client = new HttpClient({
      baseUrl: this.baseUrl,
      timeout: 30000,
      dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    });
    if (this.sessionCookieHeader) {
      this.client.setHeader("Cookie", this.sessionCookieHeader);
    }
  }

  // Authenticated request with logging
  public async request<T = unknown>(
    method: string,
    urlPath: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    const requestId = Math.random().toString(36).substr(2, 9);
    const isOrderSubmission = method.toUpperCase() === "POST"
      && /^\/iserver\/account\/[^/]+\/orders$/.test(urlPath);
    Logger.log(`[REQUEST-${requestId}] ${method} ${urlPath}`, {
      timeout: options?.timeout ?? 30000,
      headers: options?.headers,
      data: isOrderSubmission ? "[REDACTED ORDER REQUEST]" : options?.body,
    });

    if (!this.isAuthenticated) {
      Logger.log(`[REQUEST-${requestId}] Not authenticated, authenticating... (attempt ${this.authAttempts + 1}/${this.maxAuthAttempts})`);
      if (this.authAttempts >= this.maxAuthAttempts) {
        throw new Error(`Max authentication attempts (${this.maxAuthAttempts}) exceeded`);
      }
      await this.authenticate();
    }

    try {
      const result = await this.client.request<T>(method, urlPath, options);
      Logger.log(`[RESPONSE-${requestId}] ${result.status} ${result.statusText}`, {
        url: urlPath,
        responseSize: JSON.stringify(result.data).length,
        dataPreview: isOrderSubmission
          ? "[REDACTED ORDER RESPONSE]"
          : JSON.stringify(result.data).substring(0, 500) + "...",
      });
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        Logger.error(`[ERROR-${requestId}] Request failed:`, {
          url: urlPath,
          status: error.response.status,
          statusText: error.response.statusText,
          message: error.message,
          responseData: isOrderSubmission ? "[REDACTED ORDER RESPONSE]" : error.response.data,
        });
      } else {
        Logger.error(`[ERROR-${requestId}] Request failed:`, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  setSessionCookies(cookies: Array<{ name?: string; value?: string; domain?: string }>): void {
    const gatewayCookieNames = new Set(["SBID", "device.info", "TABID", "XYZAB_AM.LOGIN", "XYZAB"]);
    const localhostCookies = (cookies || []).filter((cookie) => {
      if (!cookie?.name || !cookie?.value) return false;
      const domain = String(cookie.domain || "").toLowerCase();
      const localDomain = !domain || domain === "localhost" || domain === "127.0.0.1" || domain.endsWith(".localhost");
      return localDomain && gatewayCookieNames.has(cookie.name);
    });

    const header = localhostCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    this.sessionCookieHeader = header || undefined;

    if (this.sessionCookieHeader) {
      this.client.setHeader("Cookie", this.sessionCookieHeader);
    } else {
      this.client.removeHeader("Cookie");
    }

    Logger.log(`[AUTH] Captured ${localhostCookies.length}/${(cookies || []).length} localhost browser cookies for REST API calls`);
  }

  private isStatusAuthenticated(status: unknown): boolean {
    if (!status || typeof status !== "object") return false;
    const s = status as AuthStatusResponse;
    // A competing session means IBKR has handed the brokerage session to another
    // client (phone app, web portal, a second gateway). The gateway keeps reporting
    // established/authenticated, but requests against it fail. Treat it as unhealthy
    // so recovery escalates instead of us trusting a session we no longer hold.
    if (s.competing === true) return false;
    if (s.established === true) return true;
    return s.authenticated === true && s.connected !== false;
  }

  updatePort(newPort: number): void {
    if (this.config.port !== newPort) {
      Logger.log(`[CLIENT] Updating port from ${this.config.port} to ${newPort}`);
      this.stopTickle();
      this.config.port = newPort;
      this.isAuthenticated = false;
      this.authAttempts = 0;
      this.initializeClient();
    }
  }

  async checkAuthenticationStatus(): Promise<boolean> {
    try {
      Logger.log("[AUTH-CHECK] Checking authentication status...");
      const response = await this.client.request<AuthStatusResponse>("GET", "/iserver/auth/status");
      Logger.log("[AUTH-CHECK] Auth status response:", response.data);

      const authenticated = this.isStatusAuthenticated(response.data);
      this.isAuthenticated = authenticated;

      if (authenticated) {
        this.authAttempts = 0;
        this.startTickle();
      } else {
        this.stopTickle();
      }
      return authenticated;
    } catch {
      this.isAuthenticated = false;
      this.stopTickle();
      return false;
    }
  }

  private async tickle(): Promise<void> {
    try {
      let response: HttpResponse<TickleResponse>;
      try {
        response = await this.client.request<TickleResponse>("POST", "/tickle", { timeout: 10000 });
      } catch (error: unknown) {
        if (error instanceof HttpError && (error.response.status === 404 || error.response.status === 405)) {
          response = await this.client.request<TickleResponse>("GET", "/tickle", { timeout: 10000 });
        } else {
          throw error;
        }
      }

      const authStatus = response.data?.iserver?.authStatus;
      if (authStatus && !this.isStatusAuthenticated(authStatus)) {
        Logger.warn("[TICKLE] Tickle returned unauthenticated status:", authStatus);
        await this.recoverBrokerageSession();
        return;
      }
      this.tickleFailures = 0;
      Logger.log("[TICKLE] Session maintenance ping sent successfully");
    } catch (error) {
      // Connection refused, socket hang-up, gateway restarting, machine asleep: none
      // of these mean the session is gone. Tolerate a run of them rather than tearing
      // the loop down on the first blip and letting the session decay silently.
      this.tickleFailures++;
      Logger.warn(`[TICKLE] Session maintenance ping failed (${this.tickleFailures}/${this.maxTickleFailures}):`, error);
      if (this.tickleFailures >= this.maxTickleFailures) {
        Logger.warn("[TICKLE] Gateway unreachable for too long, stopping tickle interval");
        this.isAuthenticated = false;
        this.stopTickle();
      }
    }
  }

  /**
   * The brokerage session expires well before the SSO session does, so a plain
   * reauthenticate is normally enough to bring it back - no browser, no 2FA, and no
   * exposure to IBKR's login rate limits. Only give up once that fails, at which
   * point the next tool call drives a full login.
   */
  private async recoverBrokerageSession(): Promise<void> {
    try {
      if (await this.initializeBrokerageSession()) {
        this.tickleFailures = 0;
        Logger.log("[TICKLE] Brokerage session recovered without a full login");
        return;
      }
    } catch (error) {
      Logger.warn("[TICKLE] Brokerage session recovery threw:", error);
    }

    Logger.warn("[TICKLE] Could not recover the brokerage session; a full login is required");
    this.isAuthenticated = false;
    this.stopTickle();
  }

  private startTickle(): void {
    if (this.tickleInterval) return;
    Logger.log(`[TICKLE] Starting automatic session maintenance (interval: ${this.tickleIntervalMs}ms)`);
    this.tickleInterval = setInterval(() => { this.tickle(); }, this.tickleIntervalMs);
    try {
      this.spawnDurableTickler();
    } catch (error) {
      Logger.error("[TICKLE] Failed to spawn durable background tickler:", error);
    }
  }

  private spawnDurableTickler(): void {
    if (!fs.existsSync(this.runtimeDir)) {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
    }

    if (fs.existsSync(this.ticklerJsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.ticklerJsonPath, "utf8"));
        if (data && typeof data.pid === "number") {
          const isSameTarget = data.host === this.config.host && data.port === this.config.port;
          if (this.isProcessRunning(data.pid)) {
            if (isSameTarget) {
              Logger.log(`[TICKLE] Durable tickler already running with PID ${data.pid}`);
              return;
            }
            Logger.log(`[TICKLE] Replacing durable tickler PID ${data.pid} for ${data.host}:${data.port} with ${this.config.host}:${this.config.port}`);
            if (!this.stopProcess(data.pid)) {
              Logger.warn(`[TICKLE] Existing durable tickler PID ${data.pid} could not be stopped. Skipping respawn.`);
              return;
            }
          } else {
            Logger.log(`[TICKLE] Stale durable tickler file found (PID ${data.pid} not running). Spawning new one.`);
          }
          fs.unlinkSync(this.ticklerJsonPath);
        }
      } catch (err) {
        Logger.warn("[TICKLE] Failed to read or parse tickler-session.json, will overwrite:", err);
      }
    }

    if (!fs.existsSync(this.ticklerScriptPath)) {
      Logger.error(`[TICKLE] Tickler script not found at ${this.ticklerScriptPath}`);
      return;
    }

    Logger.log(`[TICKLE] Spawning detached durable tickler background process for port ${this.config.port}...`);
    const child = spawn(
      process.execPath,
      [this.ticklerScriptPath, this.config.host, String(this.config.port)],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [TICKLER_COOKIE_ENV]: this.sessionCookieHeader || "" },
      },
    );
    child.unref();

    if (child.pid) {
      Logger.log(`[TICKLE] Spawned durable tickler background process successfully (PID: ${child.pid})`);
      fs.writeFileSync(
        this.ticklerJsonPath,
        JSON.stringify({ pid: child.pid, host: this.config.host, port: this.config.port, spawnedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } else {
      Logger.error("[TICKLE] Detached tickler spawned but pid is missing.");
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EPERM") return true;
      if (code === "ESRCH") return false;
      throw error;
    }
  }

  private stopProcess(pid: number): boolean {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return true;
      if (code === "EPERM") return false;
      throw error;
    }
  }

  private stopTickle(): void {
    if (this.tickleInterval) {
      Logger.log("[TICKLE] Stopping automatic session maintenance");
      clearInterval(this.tickleInterval);
      this.tickleInterval = undefined;
    }
  }

  public destroy(): void {
    this.stopTickle();
  }

  // ---------------------------------------------------------------------------
  // Brokerage session initialization
  // ---------------------------------------------------------------------------

  async initializeBrokerageSession(): Promise<boolean> {
    const hasSessionCookies = Boolean(this.sessionCookieHeader);
    const sleep = (ms: number) =>
      hasSessionCookies ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

    const tryRequest = async <T>(label: string, fn: () => Promise<HttpResponse<T>>): Promise<HttpResponse<T> | undefined> => {
      try {
        const response = await fn();
        if (response.data !== null && typeof response.data === "object" && "error" in response.data) {
          Logger.warn(`[BROKERAGE-INIT] ${label} returned error body; continuing:`, (response.data as Record<string, unknown>).error);
        } else {
          Logger.log(`[BROKERAGE-INIT] ${label} returned ${response.status || "ok"}`);
        }
        return response;
      } catch (error: unknown) {
        Logger.warn(`[BROKERAGE-INIT] ${label} failed or is not ready; continuing:`, error instanceof Error ? error.message : String(error));
        return undefined;
      }
    };

    const applyStatus = (status: unknown): boolean => {
      const authenticated = this.isStatusAuthenticated(status);
      this.isAuthenticated = authenticated;
      if (authenticated) { this.authAttempts = 0; this.startTickle(); }
      else { this.stopTickle(); }
      return authenticated;
    };

    const runOfficialSequence = async (skipDefaultHeaders: boolean, labelPrefix: string, expectFinal = false): Promise<unknown> => {
      Logger.log(`[BROKERAGE-INIT] Running official Gateway brokerage sequence (${labelPrefix})...`);
      const opts: RequestOptions = skipDefaultHeaders ? { skipDefaultHeaders: true } : {};

      const ssoValidateResponse = await tryRequest(`${labelPrefix} GET /v1/api/sso/validate`,
        () => this.client.request("GET", "/sso/validate", opts));
      const ssoValidation = ssoValidateResponse?.data || {};

      let statusResponse = await tryRequest<AuthStatusResponse>(`${labelPrefix} GET /v1/api/iserver/auth/status`,
        () => this.client.request<AuthStatusResponse>("GET", "/iserver/auth/status", opts));
      if (this.isStatusAuthenticated(statusResponse?.data)) return statusResponse?.data;

      await tryRequest(`${labelPrefix} GET /v1/api/iserver/accounts`,
        () => this.client.request("GET", "/iserver/accounts", opts));

      const authStatus: AuthStatusResponse = (statusResponse?.data as AuthStatusResponse) ?? {};
      const authHardware = String(authStatus.hardware_info || "");
      const ssoHardware = String((ssoValidation as { HARDWARE_INFO?: string }).HARDWARE_INFO || "");
      const rawHardware = authHardware || ssoHardware;
      const hardwareParts = rawHardware.split("|");
      const machineId = hardwareParts[0] || "";
      const rawMac = authHardware
        ? String(authStatus.MAC || hardwareParts[1] || "")
        : String(hardwareParts[1] || authStatus.MAC || "");
      const mac = rawMac.replaceAll(":", "-");

      if (machineId && mac) {
        const ssodhBody = new URLSearchParams({ compete: "true", locale: "en_US", mac, machineId, username: "-" }).toString();
        await tryRequest(`${labelPrefix} POST /v1/api/iserver/auth/ssodh/init with official form body`,
          () => this.client.request("POST", "/iserver/auth/ssodh/init", {
            ...opts, body: ssodhBody, headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }));
      } else {
        await tryRequest(`${labelPrefix} POST /v1/api/iserver/auth/ssodh/init fallback empty body`,
          () => this.client.request("POST", "/iserver/auth/ssodh/init", opts));
      }

      await sleep(1000);
      const gatewayBaseUrl = this.baseUrl.replace(/\/v1\/api\/?$/, "");
      await tryRequest(`${labelPrefix} POST /v1/portal/iserver/reauthenticate?force=true`,
        () => this.client.request("POST", `${gatewayBaseUrl}/v1/portal/iserver/reauthenticate?force=true`, opts));
      await sleep(1000);
      await tryRequest(`${labelPrefix} POST /v1/api/iserver/reauthenticate`,
        () => this.client.request("POST", "/iserver/reauthenticate", opts));
      await sleep(1000);
      await tryRequest(`${labelPrefix} POST /v1/api/tickle`,
        () => this.client.request("POST", "/tickle", opts));
      await tryRequest(`${labelPrefix} GET /v1/api/tickle`,
        () => this.client.request("GET", "/tickle", opts));
      await tryRequest(`${labelPrefix} GET /v1/api/portfolio/accounts`,
        () => this.client.request("GET", "/portfolio/accounts", opts));

      statusResponse = await tryRequest<AuthStatusResponse>(`${labelPrefix} GET /v1/api/iserver/auth/status`,
        () => this.client.request<AuthStatusResponse>("GET", "/iserver/auth/status", opts));
      let lastStatus: unknown = statusResponse?.data;
      Logger.log(`[BROKERAGE-INIT] Auth status after ${labelPrefix}:`, lastStatus);
      if (this.isStatusAuthenticated(lastStatus)) return lastStatus;

      const shouldPoll = expectFinal && Boolean(this.sessionCookieHeader);
      if (!shouldPoll) return lastStatus;

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await tryRequest(`${labelPrefix} POST /v1/api/tickle`,
          () => this.client.request("POST", "/tickle", opts));
        await sleep(3000);
        statusResponse = await tryRequest<AuthStatusResponse>(`${labelPrefix} GET /v1/api/iserver/auth/status`,
          () => this.client.request<AuthStatusResponse>("GET", "/iserver/auth/status", opts));
        lastStatus = statusResponse?.data;
        Logger.log(`[BROKERAGE-INIT] Auth status after ${labelPrefix}:`, lastStatus);
        if (this.isStatusAuthenticated(lastStatus)) return lastStatus;
      }
      return lastStatus;
    };

    if (hasSessionCookies) {
      await runOfficialSequence(true, "no-cookie", false);
    }
    const finalStatus = await runOfficialSequence(false, hasSessionCookies ? "browser-cookie" : "default", true);
    return applyStatus(finalStatus);
  }

  async reauthenticate(): Promise<void> {
    try {
      const authenticated = await this.initializeBrokerageSession();
      if (authenticated) {
        Logger.log("[REAUTH] Re-authentication successful");
      } else {
        Logger.warn("[REAUTH] Re-authentication request sent but auth status is still false, will retry via interceptor");
      }
    } catch (error) {
      Logger.warn("[REAUTH] Re-authentication failed, will fall back to interceptor-based auth:", error);
      this.isAuthenticated = false;
      this.stopTickle();
    }
  }

  private async authenticate(): Promise<void> {
    Logger.log(`[AUTH] Starting authentication process... (attempt ${this.authAttempts + 1}/${this.maxAuthAttempts})`);
    this.authAttempts++;
    try {
      const authenticated = await this.initializeBrokerageSession();
      if (authenticated) { Logger.log("[AUTH] Brokerage session authenticated"); return; }
      throw new Error("Gateway is reachable but the IBKR brokerage session is not authenticated yet. Complete browser/2FA login and retry.");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      Logger.error(`[AUTH] Authentication failed (attempt ${this.authAttempts}/${this.maxAuthAttempts}):`, msg, stack);
      this.isAuthenticated = false;
      this.stopTickle();
      if (this.authAttempts >= this.maxAuthAttempts) {
        throw new Error(`Failed to authenticate with IB Gateway after ${this.maxAuthAttempts} attempts: ${msg}`);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // API methods
  // ---------------------------------------------------------------------------

  async getAccountInfo(): Promise<{ accounts: unknown; summaries: Array<{ accountId: string; summary: unknown }> }> {
    return getAccountInfo(this);
  }

  async getPositions(accountId?: string): Promise<unknown> {
    return getPositions(this, accountId);
  }

  async getOptionChain(
    symbol: string,
    exchange?: string,
  ): Promise<{
    symbol: string;
    underlyingConid: number;
    expirations: Array<{ expiry: string; call: number[]; put: number[] }>;
  }> {
    return getOptionChain(this, symbol, exchange);
  }

  async resolveOptionConid(
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
    return resolveOptionConid(this, symbol, expiry, strike, right, exchange);
  }

  async getMarketData(symbol: string, exchange?: string): Promise<{ symbol: string; contract: ContractSearch; marketData: unknown }> {
    return getMarketData(this, symbol, exchange);
  }

  async placeOrder(orderRequest: OrderRequest): Promise<unknown> {
    return placeOrder(this, orderRequest);
  }

  async prepareOrder(orderRequest: OrderRequest): Promise<PreparedOrder> {
    return prepareOrder(this, orderRequest);
  }

  async submitPreparedOrder(prepared: PreparedOrder): Promise<unknown> {
    return submitPreparedOrder(this, prepared);
  }

  async confirmOrder(replyId: string, messageIds: string[]): Promise<unknown> {
    return confirmOrder(this, replyId, messageIds);
  }

  async getOrderStatus(orderId: string): Promise<unknown> {
    return getOrderStatus(this, orderId);
  }

  async getOrders(accountId?: string): Promise<unknown> {
    return getOrders(this, accountId);
  }

  async getAlerts(accountId: string): Promise<unknown> {
    return getAlerts(this, accountId);
  }

  async createAlert(accountId: string, alertRequest: unknown): Promise<unknown> {
    return createAlert(this, accountId, alertRequest);
  }

  async activateAlert(accountId: string, alertId: string): Promise<unknown> {
    return activateAlert(this, accountId, alertId);
  }

  async deleteAlert(accountId: string, alertId: string): Promise<unknown> {
    return deleteAlert(this, accountId, alertId);
  }
}
