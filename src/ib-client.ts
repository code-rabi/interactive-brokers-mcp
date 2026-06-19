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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKLER_COOKIE_ENV = "IB_TICKLER_COOKIE_HEADER";

// ---------------------------------------------------------------------------
// IB Gateway response shapes — only the fields we actually access
// ---------------------------------------------------------------------------

interface AuthStatusResponse {
  authenticated?: boolean;
  connected?: boolean;
  established?: boolean;
  MAC?: string;
  hardware_info?: string;
}

interface TickleResponse {
  iserver?: { authStatus?: AuthStatusResponse };
}

interface ContractSection {
  secType?: string;
  months?: string;
  exchange?: string;
}

interface ContractSearch {
  conid: number | string;
  symbol: string;
  description?: string;
  companyHeader?: string;
  sections?: ContractSection[];
}

interface OptionStrikesResponse {
  call?: number[];
  put?: number[];
}

interface OptionContractInfo {
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

interface OrderConfirmation {
  id?: string;
  message?: string[];
  messageIds?: string[];
}

interface OrderPayload {
  conid: number;
  orderType: string;
  side: string;
  quantity: number;
  tif: string;
  secType?: string;
  exchange?: string;
  price?: number;
  auxPrice?: number;
}

interface AccountEntry {
  id?: string;
}

// ---------------------------------------------------------------------------
// Config & public types
// ---------------------------------------------------------------------------

interface IBClientConfig {
  host: string;
  port: number;
}

interface ContractLookupRequest {
  symbol?: string;
  conid?: number;
  secType?: "STK" | "OPT";
  expiry?: string;
  strike?: number;
  right?: "C" | "P";
  exchange?: string;
}

interface MarketDataRequest extends ContractLookupRequest {}

interface OrderRequest extends ContractLookupRequest {
  accountId: string;
  action: "BUY" | "SELL";
  orderType: "MKT" | "LMT" | "STP";
  quantity: number;
  price?: number;
  stopPrice?: number;
  suppressConfirmations?: boolean;
  tif?: "DAY" | "GTC" | "IOC" | "OPG";
}

interface ResolvedContract {
  conid: number;
  symbol: string;
  secType: "STK" | "OPT";
  contract: ContractSearch | OptionContractInfo;
  underlyingConid?: number;
}

class AuthenticationError extends Error {
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

  // Authenticated request with logging (replaces axios interceptors)
  private async request<T = unknown>(
    method: string,
    urlPath: string,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    const requestId = Math.random().toString(36).substr(2, 9);
    Logger.log(`[REQUEST-${requestId}] ${method} ${urlPath}`, {
      timeout: options?.timeout ?? 30000,
      headers: options?.headers,
      data: options?.body,
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
        dataPreview: JSON.stringify(result.data).substring(0, 500) + "...",
      });
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        Logger.error(`[ERROR-${requestId}] Request failed:`, {
          url: urlPath,
          status: error.response.status,
          statusText: error.response.statusText,
          message: error.message,
          responseData: error.response.data,
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
        this.isAuthenticated = false;
        this.stopTickle();
        Logger.warn("[TICKLE] Tickle returned unauthenticated status:", authStatus);
        return;
      }
      Logger.log("[TICKLE] Session maintenance ping sent successfully");
    } catch (error) {
      Logger.warn("[TICKLE] Failed to send session maintenance ping:", error);
      const isAuth = await this.checkAuthenticationStatus();
      if (!isAuth) {
        Logger.warn("[TICKLE] Session expired, stopping tickle interval");
        this.stopTickle();
      }
    }
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
    Logger.log("[ACCOUNT-INFO] Starting getAccountInfo request...");
    try {
      const accountsResponse = await this.request<AccountEntry[]>("GET", "/portfolio/accounts");
      const accounts = accountsResponse.data;
      Logger.log(`[ACCOUNT-INFO] Found ${accounts?.length || 0} accounts:`, accounts);

      const summaries: Array<{ accountId: string; summary: unknown }> = [];
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        Logger.log(`[ACCOUNT-INFO] Processing account ${i + 1}/${accounts.length}: ${account.id}`);
        const summaryResponse = await this.request("GET", `/portfolio/${account.id}/summary`);
        Logger.log(`[ACCOUNT-INFO] Account ${account.id} summary:`, summaryResponse.data);
        summaries.push({ accountId: account.id!, summary: summaryResponse.data });
      }

      Logger.log(`[ACCOUNT-INFO] Completed processing ${summaries.length} accounts`);
      return { accounts, summaries };
    } catch (error: unknown) {
      Logger.error("[ACCOUNT-INFO] Failed to get account info:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to retrieve account information. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to retrieve account information");
    }
  }

  async getPositions(accountId?: string): Promise<unknown> {
    try {
      const url = accountId ? `/portfolio/${accountId}/positions` : "/portfolio/positions";
      const response = await this.request("GET", url);
      return response.data;
    } catch (error: unknown) {
      Logger.error("Failed to get positions:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to retrieve positions. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to retrieve positions");
    }
  }

  private async searchContracts(symbol: string): Promise<ContractSearch[]> {
    const response = await this.request<ContractSearch[]>(
      "GET",
      `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`,
    );

    if (!response.data || response.data.length === 0) {
      throw new SymbolNotFoundError(`Symbol ${symbol} not found`);
    }

    return response.data;
  }

  private matchesExchange(contract: ContractSearch | OptionContractInfo, exchange?: string): boolean {
    if (!exchange) return true;

    const target = exchange.toUpperCase();
    const values = [
      contract.exchange,
      contract.validExchanges,
      contract.description,
      contract.companyHeader,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toUpperCase());

    return values.some((value) => value.includes(target));
  }

  private pickContract<T extends ContractSearch | OptionContractInfo>(
    contracts: T[],
    exchange?: string,
  ): T {
    const match = contracts.find((contract) => this.matchesExchange(contract, exchange));
    return match ?? contracts[0];
  }

  private getOptionMonths(contract: ContractSearch): string[] {
    const months = contract.sections
      ?.filter((section) => section.secType === "OPT" && typeof section.months === "string")
      .flatMap((section) => section.months!.split(";"))
      .map((month) => month.trim())
      .filter(Boolean) ?? [];

    return [...new Set(months)];
  }

  private buildOptionStrikesUrl(underlyingConid: number, expiry: string, exchange?: string): string {
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

  private buildOptionInfoUrl(
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

  private async resolveUnderlyingContract(symbol: string, exchange?: string): Promise<ResolvedContract> {
    const contracts = await this.searchContracts(symbol);
    const contract = this.pickContract(contracts, exchange);

    return {
      conid: Number(contract.conid),
      symbol: contract.symbol,
      secType: "STK",
      contract,
    };
  }

  private async resolveOptionContract(request: ContractLookupRequest): Promise<ResolvedContract> {
    if (!request.symbol || !request.expiry || request.strike === undefined || !request.right) {
      throw new Error("Option contract resolution requires symbol, expiry, strike, and right");
    }

    const underlying = await this.resolveUnderlyingContract(request.symbol, request.exchange);
    const response = await this.request<OptionContractInfo[]>(
      "GET",
      this.buildOptionInfoUrl(
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

    const contract = this.pickContract(response.data, request.exchange);

    return {
      conid: Number(contract.conid),
      symbol: contract.symbol || request.symbol,
      secType: "OPT",
      contract,
      underlyingConid: underlying.conid,
    };
  }

  private async resolveContract(request: ContractLookupRequest): Promise<ResolvedContract> {
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
      return this.resolveOptionContract(request);
    }

    if (!request.symbol) {
      throw new Error("Symbol is required when conid is not provided");
    }

    return this.resolveUnderlyingContract(request.symbol, request.exchange);
  }

  async getOptionChain(symbol: string, exchange?: string): Promise<{
    symbol: string;
    underlyingConid: number;
    expirations: Array<{ expiry: string; call: number[]; put: number[] }>;
  }> {
    try {
      const underlying = await this.resolveUnderlyingContract(symbol, exchange);
      const expirations = this.getOptionMonths(underlying.contract as ContractSearch);
      const optionChain = await Promise.all(
        expirations.map(async (expiry) => {
          const response = await this.request<OptionStrikesResponse>(
            "GET",
            this.buildOptionStrikesUrl(underlying.conid, expiry, exchange),
          );

          return {
            expiry,
            call: Array.isArray(response.data?.call) ? response.data.call : [],
            put: Array.isArray(response.data?.put) ? response.data.put : [],
          };
        }),
      );

      return {
        symbol: underlying.symbol,
        underlyingConid: underlying.conid,
        expirations: optionChain,
      };
    } catch (error: unknown) {
      Logger.error("Failed to get option chain:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError(
          "Authentication required to get option chain. Please authenticate with Interactive Brokers first.",
        );
      }
      if (error instanceof SymbolNotFoundError) throw error;
      throw new Error(`Failed to get option chain for ${symbol}`);
    }
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
    try {
      const resolved = await this.resolveOptionContract({
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
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError(
          "Authentication required to resolve option contracts. Please authenticate with Interactive Brokers first.",
        );
      }
      if (error instanceof SymbolNotFoundError) throw error;
      throw new Error(`Failed to resolve option conid for ${symbol} ${expiry} ${strike} ${right}`);
    }
  }

  async getMarketData(symbol: string, exchange?: string): Promise<{ symbol: string; contract: ContractSearch; marketData: unknown }> {
    try {
      let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`;
      if (exchange) searchUrl += `&name=${encodeURIComponent(exchange)}`;
      const searchResponse = await this.request<ContractSearch[]>("GET", searchUrl);

      if (!searchResponse.data || searchResponse.data.length === 0) {
        throw new SymbolNotFoundError(`Symbol ${symbol}${exchange ? " on " + exchange : ""} not found`);
      }

      const contract = searchResponse.data[0];
      const response = await this.request("GET",
        `/iserver/marketdata/snapshot?conids=${contract.conid}&fields=31,70,71,82,83,84,85,86,87,88`,
      );
      return { symbol, contract, marketData: response.data };
    } catch (error: unknown) {
      Logger.error("Failed to get market data:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError(`Authentication required to retrieve market data for ${symbol}. Please authenticate with Interactive Brokers first.`);
      }
      if (error instanceof SymbolNotFoundError) throw error;
      throw new Error(`Failed to retrieve market data for ${symbol}`);
    }
  }

  private isAuthenticationError(error: unknown): boolean {
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

  async placeOrder(orderRequest: OrderRequest): Promise<unknown> {
    try {
      if (orderRequest.conid !== undefined || orderRequest.secType === "OPT") {
        const contract = await this.resolveContract(orderRequest);
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

        const response = await this.request<OrderConfirmation[]>(
          "POST",
          `/iserver/account/${orderRequest.accountId}/orders`,
          { body: { orders: [order] } },
        );

        if (Array.isArray(response.data) && response.data.length > 0) {
          const first = response.data[0];
          if (first.id && first.message && first.messageIds && orderRequest.suppressConfirmations) {
            Logger.log("Order confirmation received, auto-confirming", first);
            return await this.confirmOrder(first.id, first.messageIds);
          }
        }

        return response.data;
      }

      let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(orderRequest.symbol)}`;
      if (orderRequest.exchange) searchUrl += `&name=${encodeURIComponent(orderRequest.exchange)}`;
      const searchResponse = await this.request<ContractSearch[]>("GET", searchUrl);

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

      const response = await this.request<OrderConfirmation[]>("POST",
        `/iserver/account/${orderRequest.accountId}/orders`,
        { body: { orders: [order] } },
      );

      if (Array.isArray(response.data) && response.data.length > 0) {
        const first = response.data[0];
        if (first.id && first.message && first.messageIds && orderRequest.suppressConfirmations) {
          Logger.log("Order confirmation received, automatically confirming...", first);
          return await this.confirmOrder(first.id, first.messageIds);
        }
      }
      return response.data;
    } catch (error: unknown) {
      Logger.error("Failed to place order:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to place orders. Please authenticate with Interactive Brokers first.");
      }
      if (error instanceof SymbolNotFoundError) throw error;
      throw new Error("Failed to place order");
    }
  }

  async confirmOrder(replyId: string, messageIds: string[]): Promise<unknown> {
    try {
      Logger.log(`Confirming order with reply ID ${replyId} and message IDs:`, messageIds);
      const response = await this.request("POST", `/iserver/reply/${replyId}`, {
        body: { confirmed: true, messageIds },
      });
      Logger.log("Order confirmation response:", response.data);
      return response.data;
    } catch (error: unknown) {
      Logger.error("Failed to confirm order:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to confirm orders. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to confirm order: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async getOrderStatus(orderId: string): Promise<unknown> {
    try {
      const response = await this.request("GET", `/iserver/account/orders/${orderId}`);
      return response.data;
    } catch (error: unknown) {
      Logger.error("Failed to get order status:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError(`Authentication required to get order status for order ${orderId}. Please authenticate with Interactive Brokers first.`);
      }
      throw new Error(`Failed to get status for order ${orderId}`);
    }
  }

  private normalizeAccountId(account: unknown): string | undefined {
    if (!account) return undefined;
    if (typeof account === "string") return account.trim() || undefined;
    if (typeof account === "object" && account !== null) {
      const obj = account as Record<string, unknown>;
      const id = obj.id ?? obj.accountId ?? obj.account_id ?? obj.acctId ?? obj.account;
      return typeof id === "string" && id.trim() ? id.trim() : undefined;
    }
    return undefined;
  }

  private extractAccountIds(data: unknown): string[] {
    const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
    const candidates: unknown[] = [
      ...(Array.isArray(data) ? data : []),
      ...(Array.isArray(obj?.accounts) ? (obj.accounts as unknown[]) : []),
      ...(Array.isArray(obj?.accountIds) ? (obj.accountIds as unknown[]) : []),
      obj?.selectedAccount,
      obj?.selected_account,
    ];
    return [...new Set(
      candidates.map((a) => this.normalizeAccountId(a)).filter((id): id is string => Boolean(id)),
    )];
  }

  private extractOrders(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.orders)) return obj.orders as unknown[];
    }
    return [];
  }

  private async getOrderAccountIds(): Promise<string[]> {
    const sources = [
      { label: "/iserver/accounts", fetch: () => this.request("GET", "/iserver/accounts") },
      { label: "/portfolio/accounts", fetch: () => this.request("GET", "/portfolio/accounts") },
    ];
    for (const source of sources) {
      try {
        const response = await source.fetch();
        const ids = this.extractAccountIds(response.data);
        if (ids.length > 0) return ids;
      } catch (error) {
        Logger.warn(`[ORDERS] Failed to discover accounts via ${source.label}:`, error);
      }
    }
    return [];
  }

  async getOrders(accountId?: string): Promise<unknown> {
    try {
      const url = "/iserver/account/orders";
      if (accountId) {
        const response = await this.request("GET", url, { params: { accountId } });
        return response.data;
      }

      const accountIds = await this.getOrderAccountIds();
      if (accountIds.length === 0) {
        Logger.warn("[ORDERS] Could not discover account IDs; falling back to unscoped orders request");
        const response = await this.request("GET", url);
        return response.data;
      }

      const accountResults: Array<{ accountId: string; data: unknown }> = [];
      const orders: unknown[] = [];
      for (const id of accountIds) {
        const response = await this.request("GET", url, { params: { accountId: id } });
        accountResults.push({ accountId: id, data: response.data });
        orders.push(...this.extractOrders(response.data));
      }
      return { orders, accountResults };
    } catch (error: unknown) {
      Logger.error("Failed to get orders:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to retrieve orders. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to retrieve orders");
    }
  }

  async getAlerts(accountId: string): Promise<unknown> {
    try {
      Logger.log(`[ALERT] Getting alerts for account ${accountId}`);
      const response = await this.request("GET", `/iserver/account/${accountId}/alerts`);
      Logger.log("[ALERT] Get alerts response:", response.data);
      return response.data;
    } catch (error: unknown) {
      Logger.error("[ALERT] Failed to get alerts:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to get alerts. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to get alerts: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async createAlert(accountId: string, alertRequest: unknown): Promise<unknown> {
    try {
      Logger.log(`[ALERT] Creating alert for account ${accountId}:`, alertRequest);
      const response = await this.request("POST", `/iserver/account/${accountId}/alert`, { body: alertRequest });
      Logger.log("[ALERT] Alert creation response:", response.data);
      return response.data;
    } catch (error: unknown) {
      Logger.error("[ALERT] Failed to create alert:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to create alerts. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to create alert: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async activateAlert(accountId: string, alertId: string): Promise<unknown> {
    try {
      Logger.log(`[ALERT] Activating alert ${alertId} for account ${accountId}`);
      const response = await this.request("POST", `/iserver/account/${accountId}/alert/activate`, { body: { alertId } });
      Logger.log("[ALERT] Alert activation response:", response.data);
      return response.data;
    } catch (error: unknown) {
      Logger.error("[ALERT] Failed to activate alert:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to activate alerts. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to activate alert: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async deleteAlert(accountId: string, alertId: string): Promise<unknown> {
    try {
      Logger.log(`[ALERT] Deleting alert ${alertId} for account ${accountId}`);
      const response = await this.request("DELETE", `/iserver/account/${accountId}/alert/${alertId}`);
      Logger.log("[ALERT] Alert deletion response:", response.data);
      return response.data;
    } catch (error: unknown) {
      Logger.error("[ALERT] Failed to delete alert:", error);
      if (this.isAuthenticationError(error)) {
        throw new AuthenticationError("Authentication required to delete alerts. Please authenticate with Interactive Brokers first.");
      }
      throw new Error("Failed to delete alert: " + (error instanceof Error ? error.message : String(error)));
    }
  }
}
