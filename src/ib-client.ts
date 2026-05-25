import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import https from "https";
import { Logger } from "./logger.js";

interface ExtendedAxiosRequestConfig extends AxiosRequestConfig {
  metadata?: { requestId: string };
}

interface IBClientConfig {
  host: string;
  port: number;
}

interface OrderRequest {
  accountId: string;
  symbol: string;
  action: "BUY" | "SELL";
  orderType: "MKT" | "LMT" | "STP";
  quantity: number;
  price?: number;
  stopPrice?: number;
  suppressConfirmations?: boolean;
  exchange?: string;
  tif?: "DAY" | "GTC" | "IOC" | "OPG";
}

const isError = (error: unknown): error is Error => {
  return error instanceof Error;
};

/**
 * Thrown when a symbol (optionally scoped to an exchange) cannot be resolved
 * via `secdef/search`. Distinct error class so callers receive the specific
 * "Symbol ... not found" message instead of a swallowed generic one.
 */
export class SymbolNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymbolNotFoundError";
  }
}

export class IBClient {
  private client!: AxiosInstance;
  private baseUrl!: string;
  private config: IBClientConfig;
  private isAuthenticated = false;
  private authAttempts = 0;
  private maxAuthAttempts = 3;
  private tickleInterval?: NodeJS.Timeout;
  private tickleIntervalMs = 30000; // 30 seconds (well within 1/sec rate limit)
  private sessionCookieHeader?: string;

  constructor(config: IBClientConfig) {
    this.config = config;
    this.initializeClient();
  }

  private initializeClient(): void {
    // Use HTTPS as IB Gateway expects it
    this.baseUrl = `https://${this.config.host}:${this.config.port}/v1/api`;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      // Allow self-signed certificates
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    });

    // Add request interceptor to ensure authentication and log requests
    this.client.interceptors.request.use(async (config) => {
      const requestId = Math.random().toString(36).substr(2, 9);
      Logger.log(`[REQUEST-${requestId}] ${config.method?.toUpperCase()} ${config.url}`, {
        baseURL: config.baseURL,
        timeout: config.timeout,
        headers: config.headers,
        data: config.data
      });
      
      if (!this.isAuthenticated) {
        Logger.log(`[REQUEST-${requestId}] Not authenticated, authenticating... (attempt ${this.authAttempts + 1}/${this.maxAuthAttempts})`);
        if (this.authAttempts >= this.maxAuthAttempts) {
          throw new Error(`Max authentication attempts (${this.maxAuthAttempts}) exceeded`);
        }
        await this.authenticate();
      }
      
      // Store requestId for response logging
      (config as ExtendedAxiosRequestConfig).metadata = { requestId };
      return config;
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        const requestId = (response.config as ExtendedAxiosRequestConfig).metadata?.requestId || 'unknown';
        Logger.log(`[RESPONSE-${requestId}] ${response.status} ${response.statusText}`, {
          url: response.config.url,
          responseSize: JSON.stringify(response.data).length,
          headers: response.headers,
          dataPreview: JSON.stringify(response.data).substring(0, 500) + '...'
        });
        return response;
      },
      (error) => {
        const requestId = (error.config as ExtendedAxiosRequestConfig)?.metadata?.requestId || 'unknown';
          Logger.error(`[ERROR-${requestId}] Request failed:`, {
          url: error.config?.url,
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
          responseData: error.response?.data
        });
        return Promise.reject(error);
      }
    );
  }

  setSessionCookies(cookies: Array<{ name?: string; value?: string; domain?: string }>): void {
    const gatewayCookieNames = new Set(["SBID", "device.info", "TABID", "XYZAB_AM.LOGIN", "XYZAB"]);
    const localhostCookies = (cookies || []).filter((cookie) => {
      if (!cookie?.name || !cookie?.value) {
        return false;
      }

      const domain = String(cookie.domain || "").toLowerCase();
      // Match the browser cookies Gateway itself sets on localhost. Forwarding
      // unrelated redirect/login cookies can prevent brokerage-session init from
      // reaching established=true on some Client Portal Gateway builds.
      const localDomain = !domain || domain === "localhost" || domain === "127.0.0.1" || domain.endsWith(".localhost");
      return localDomain && gatewayCookieNames.has(cookie.name);
    });

    const header = localhostCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    this.sessionCookieHeader = header || undefined;
    if (this.client) {
      if (this.sessionCookieHeader) {
        this.client.defaults.headers.common.Cookie = this.sessionCookieHeader;
      } else {
        delete this.client.defaults.headers.common.Cookie;
      }
    }

    Logger.log(`[AUTH] Captured ${localhostCookies.length}/${(cookies || []).length} localhost browser cookies for REST API calls`);
  }

  private createRawClient(timeout = 30000): AxiosInstance {
    return axios.create({
      baseURL: this.baseUrl,
      timeout,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
      headers: this.sessionCookieHeader ? { Cookie: this.sessionCookieHeader } : undefined,
    });
  }

  private isStatusAuthenticated(status: any): boolean {
    if (!status || typeof status !== "object") {
      return false;
    }

    // Newer Gateway responses can distinguish authenticated browser login from
    // an established brokerage session. Treat established=true as authoritative;
    // otherwise preserve compatibility with older responses that omit it.
    if (status.established === true) {
      return true;
    }

    return status.authenticated === true && status.connected !== false;
  }

  updatePort(newPort: number): void {
    if (this.config.port !== newPort) {
      Logger.log(`[CLIENT] Updating port from ${this.config.port} to ${newPort}`);
      this.stopTickle(); // Stop tickle for old session
      this.config.port = newPort;
      this.isAuthenticated = false; // Force re-authentication with new port
      this.authAttempts = 0; // Reset auth attempts
      this.initializeClient(); // Re-initialize client with new port
    }
  }

  /**
   * Check authentication status with IB Gateway without triggering automatic authentication
   */
  async checkAuthenticationStatus(): Promise<boolean> {
    try {
      Logger.log("[AUTH-CHECK] Checking authentication status...");
      
      // Create a new axios instance without interceptors to avoid triggering authentication
      const authClient = this.createRawClient();
      
      const response = await authClient.get("/iserver/auth/status");
      Logger.log("[AUTH-CHECK] Auth status response:", response.data);
      
      const authenticated = this.isStatusAuthenticated(response.data);
      this.isAuthenticated = authenticated;
      
      if (authenticated) {
        this.authAttempts = 0; // Reset auth attempts on successful check
        this.startTickle(); // Start session maintenance
      } else {
        this.stopTickle(); // Stop tickle if not authenticated
      }
      
      return authenticated;
    } catch (error) {
      this.isAuthenticated = false;
      this.stopTickle();
      return false;
    }
  }

  /**
   * Send a tickle request to maintain the session
   * Rate limit: 1 request per second (we use 30 second intervals to be safe)
   */
  private async tickle(): Promise<void> {
    try {
      const tickleClient = this.createRawClient(10000);

      const response = await tickleClient.post("/tickle").catch(async (error) => {
        // Some Client Portal Gateway builds/documentation expose /tickle as GET,
        // while OAuth examples use POST. Retry GET only when the method appears
        // unsupported to avoid masking real authentication/network failures.
        if (error?.response?.status === 404 || error?.response?.status === 405) {
          return tickleClient.get("/tickle");
        }
        throw error;
      });

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
      // If tickle fails, check authentication status
      const isAuth = await this.checkAuthenticationStatus();
      if (!isAuth) {
        Logger.warn("[TICKLE] Session expired, stopping tickle interval");
        this.stopTickle();
      }
    }
  }

  /**
   * Start automatic session maintenance
   */
  private startTickle(): void {
    if (this.tickleInterval) {
      return; // Already running
    }
    
    Logger.log(`[TICKLE] Starting automatic session maintenance (interval: ${this.tickleIntervalMs}ms)`);
    this.tickleInterval = setInterval(() => {
      this.tickle();
    }, this.tickleIntervalMs);
  }

  /**
   * Stop automatic session maintenance
   */
  private stopTickle(): void {
    if (this.tickleInterval) {
      Logger.log("[TICKLE] Stopping automatic session maintenance");
      clearInterval(this.tickleInterval);
      this.tickleInterval = undefined;
    }
  }

  /**
   * Cleanup method to stop tickle when client is destroyed
   */
  public destroy(): void {
    this.stopTickle();
  }

  /**
   * Initialize/recover the Client Portal Gateway brokerage session.
   *
   * A Gateway web login can produce a valid SSO session while `/iserver/auth/status`
   * remains `authenticated:false`. IBKR's brokerage-session init endpoint requires
   * an x-www-form-urlencoded body derived from auth/status. An empty POST may return
   * HTTP 200 but leave the session unauthenticated with:
   * "Force compete capability must be used together with compete flag".
   *
   * Some Gateway builds also require the browser's localhost SSO cookies when
   * converting web login state into an established brokerage session. Run the
   * documented sequence once without cookies to prime the Gateway, then repeat it
   * with the filtered browser-cookie header captured from Playwright.
   */
  async initializeBrokerageSession(): Promise<boolean> {
    const cookieClient = this.createRawClient();
    const noCookieClient = this.sessionCookieHeader
      ? axios.create({
          baseURL: this.baseUrl,
          timeout: 30000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        })
      : undefined;

    const sleep = (ms: number) => this.sessionCookieHeader
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve();

    const tryRequest = async (label: string, fn: () => Promise<any>) => {
      try {
        const response = await fn();
        if (response?.data?.error) {
          Logger.warn(`[BROKERAGE-INIT] ${label} returned error body; continuing:`, response.data.error);
          return response;
        }
        Logger.log(`[BROKERAGE-INIT] ${label} returned ${response?.status || "ok"}`);
        return response;
      } catch (error: any) {
        Logger.warn(`[BROKERAGE-INIT] ${label} failed or is not ready; continuing:`, error?.message || String(error));
        return undefined;
      }
    };

    const applyStatus = (status: any): boolean => {
      const authenticated = this.isStatusAuthenticated(status);
      this.isAuthenticated = authenticated;
      if (authenticated) {
        this.authAttempts = 0;
        this.startTickle();
      } else {
        this.stopTickle();
      }
      return authenticated;
    };

    const runOfficialSequence = async (client: AxiosInstance, labelPrefix: string, expectFinal = false): Promise<any> => {
      Logger.log(`[BROKERAGE-INIT] Running official Gateway brokerage sequence (${labelPrefix})...`);

      await tryRequest(`${labelPrefix} GET /v1/api/sso/validate`, () => client.get("/sso/validate"));
      let statusResponse = await tryRequest(`${labelPrefix} GET /v1/api/iserver/auth/status`, () => client.get("/iserver/auth/status"));
      if (this.isStatusAuthenticated(statusResponse?.data)) {
        return statusResponse?.data;
      }

      // Non-fatal primer: this can return 401 before brokerage init, but it also
      // nudges Gateway-side server state in some deployments.
      await tryRequest(`${labelPrefix} GET /v1/api/iserver/accounts`, () => client.get("/iserver/accounts"));

      const authStatus = statusResponse?.data || {};
      const rawMac = String(authStatus.MAC || "");
      const rawHardware = String(authStatus.hardware_info || "");
      const machineId = rawHardware.split("|")[0] || "";
      const mac = rawMac.replaceAll(":", "-");

      if (machineId && mac) {
        const ssodhBody = new URLSearchParams({
          compete: "true",
          locale: "en_US",
          mac,
          machineId,
          username: "-",
        }).toString();

        await tryRequest(`${labelPrefix} POST /v1/api/iserver/auth/ssodh/init with official form body`, () =>
          client.post("/iserver/auth/ssodh/init", ssodhBody, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          })
        );
      } else {
        await tryRequest(`${labelPrefix} POST /v1/api/iserver/auth/ssodh/init fallback empty body`, () =>
          client.post("/iserver/auth/ssodh/init")
        );
      }

      await sleep(1000);
      const gatewayBaseUrl = this.baseUrl.replace(/\/v1\/api\/?$/, "");
      await tryRequest(`${labelPrefix} POST /v1/portal/iserver/reauthenticate?force=true`, () =>
        client.post(`${gatewayBaseUrl}/v1/portal/iserver/reauthenticate?force=true`)
      );
      await sleep(1000);
      await tryRequest(`${labelPrefix} POST /v1/api/iserver/reauthenticate`, () => client.post("/iserver/reauthenticate"));
      await sleep(1000);
      await tryRequest(`${labelPrefix} POST /v1/api/tickle`, () => client.post("/tickle"));
      await tryRequest(`${labelPrefix} GET /v1/api/tickle`, () => client.get("/tickle"));
      await tryRequest(`${labelPrefix} GET /v1/api/portfolio/accounts`, () => client.get("/portfolio/accounts"));

      statusResponse = await tryRequest(`${labelPrefix} GET /v1/api/iserver/auth/status`, () => client.get("/iserver/auth/status"));
      let lastStatus: any = statusResponse?.data;
      Logger.log(`[BROKERAGE-INIT] Auth status after ${labelPrefix}:`, lastStatus);
      if (this.isStatusAuthenticated(lastStatus)) {
        return lastStatus;
      }

      // Only poll for the browser-cookie pass, and only when browser cookies were
      // actually captured. The no-cookie pass is a primer; waiting there just adds
      // latency and makes non-browser reauth callers block unnecessarily.
      const shouldPoll = expectFinal && Boolean(this.sessionCookieHeader);
      if (!shouldPoll) {
        return lastStatus;
      }

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await tryRequest(`${labelPrefix} POST /v1/api/tickle`, () => client.post("/tickle"));
        await sleep(3000);
        statusResponse = await tryRequest(`${labelPrefix} GET /v1/api/iserver/auth/status`, () => client.get("/iserver/auth/status"));
        lastStatus = statusResponse?.data;
        Logger.log(`[BROKERAGE-INIT] Auth status after ${labelPrefix}:`, lastStatus);
        if (this.isStatusAuthenticated(lastStatus)) {
          return lastStatus;
        }
      }

      return lastStatus;
    };

    if (noCookieClient) {
      await runOfficialSequence(noCookieClient, "no-cookie", false);
    }
    const finalStatus = await runOfficialSequence(cookieClient, noCookieClient ? "browser-cookie" : "default", true);
    return applyStatus(finalStatus);
  }

  /**
   * Re-authenticate the REST API session after browser OAuth completes.
   * This must be called after the browser login creates the server-side session.
   */
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
      if (authenticated) {
        Logger.log("[AUTH] Brokerage session authenticated");
        return;
      }

      throw new Error("Gateway is reachable but the IBKR brokerage session is not authenticated yet. Complete browser/2FA login and retry.");
    } catch (error) {
      Logger.error(`[AUTH] Authentication failed (attempt ${this.authAttempts}/${this.maxAuthAttempts}):`, isError(error) && error.message, isError(error) && error.stack);
      this.isAuthenticated = false;
      this.stopTickle();
      if (this.authAttempts >= this.maxAuthAttempts) {
        throw new Error(`Failed to authenticate with IB Gateway after ${this.maxAuthAttempts} attempts: ${isError(error) ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  async getAccountInfo(): Promise<any> {
    Logger.log("[ACCOUNT-INFO] Starting getAccountInfo request...");
    try {
      Logger.log("[ACCOUNT-INFO] Fetching portfolio accounts...");
      const accountsResponse = await this.client.get("/portfolio/accounts");
      const accounts = accountsResponse.data;
      Logger.log(`[ACCOUNT-INFO] Found ${accounts?.length || 0} accounts:`, accounts);

      const result = {
        accounts: accounts,
        summaries: [] as any[]
      };

      Logger.log("[ACCOUNT-INFO] Processing account summaries...");
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        Logger.log(`[ACCOUNT-INFO] Processing account ${i + 1}/${accounts.length}: ${account.id}`);
        
        const summaryResponse = await this.client.get(
          `/portfolio/${account.id}/summary`
        );
        const summary = summaryResponse.data;
        Logger.log(`[ACCOUNT-INFO] Account ${account.id} summary:`, summary);

        result.summaries.push({
          accountId: account.id,
          summary: summary
        });
      }

      Logger.log(`[ACCOUNT-INFO] Completed processing ${result.summaries.length} accounts`);
      return result;
    } catch (error) {
      Logger.error("[ACCOUNT-INFO] Failed to get account info:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to retrieve account information. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to retrieve account information");
    }
  }

  async getPositions(accountId?: string): Promise<any> {
    try {
      let url = "/portfolio/positions";
      if (accountId) {
        url = `/portfolio/${accountId}/positions`;
      }

      const response = await this.client.get(url);
      return response.data;
    } catch (error) {
        Logger.error("Failed to get positions:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to retrieve positions. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to retrieve positions");
    }
  }

  async getMarketData(symbol: string, exchange?: string): Promise<any> {
    try {
      // First, get the contract ID for the symbol, optionally filtered by exchange
      let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`;
      if (exchange) {
        searchUrl += `&name=${encodeURIComponent(exchange)}`;
      }
      const searchResponse = await this.client.get(searchUrl);

      if (!searchResponse.data || searchResponse.data.length === 0) {
        throw new SymbolNotFoundError(`Symbol ${symbol}${exchange ? ' on ' + exchange : ''} not found`);
      }

      const contract = searchResponse.data[0];
      const conid = contract.conid;

      // Get market data snapshot
      // Using corrected field IDs based on IB Client Portal API documentation:
      // 31=Last Price, 70=Day High, 71=Day Low, 82=Change, 83=Change%, 
      // 84=Bid, 85=Ask Size, 86=Ask, 87=Volume, 88=Bid Size
      const response = await this.client.get(
        `/iserver/marketdata/snapshot?conids=${conid}&fields=31,70,71,82,83,84,85,86,87,88`
      );

      return {
        symbol: symbol,
        contract: contract,
        marketData: response.data
      };
    } catch (error) {
      Logger.error("Failed to get market data:", error);

      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error(`Authentication required to retrieve market data for ${symbol}. Please authenticate with Interactive Brokers first.`);
        (authError as any).isAuthError = true;
        throw authError;
      }

      // Preserve the specific "Symbol ... not found" message for callers
      if (error instanceof SymbolNotFoundError) {
        throw error;
      }

      throw new Error(`Failed to retrieve market data for ${symbol}`);
    }
  }

  private isAuthenticationError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = error.message || error.toString();
    const errorStatus = error.response?.status;
    const responseData = error.response?.data;
    
    // Check for common authentication error patterns
    return (
      errorStatus === 401 ||
      errorStatus === 403 ||
      errorStatus === 500 ||  // IB Gateway sometimes returns 500 for auth issues
      errorMessage.includes("authentication") ||
      errorMessage.includes("authenticate") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("not authenticated") ||
      errorMessage.includes("login") ||
      responseData?.error?.message?.includes("not authenticated") ||
      responseData?.error?.message?.includes("authentication") ||
      // IB Gateway specific patterns
      responseData?.error === "not authenticated" ||
      (errorStatus === 500 && responseData?.error?.includes("authentication"))
    );
  }

  async placeOrder(orderRequest: OrderRequest): Promise<any> {
    try {
      // First, get the contract ID for the symbol, optionally filtered by exchange
      let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(orderRequest.symbol)}`;
      if (orderRequest.exchange) {
        searchUrl += `&name=${encodeURIComponent(orderRequest.exchange)}`;
      }
      const searchResponse = await this.client.get(searchUrl);

      if (!searchResponse.data || searchResponse.data.length === 0) {
        throw new SymbolNotFoundError(`Symbol ${orderRequest.symbol}${orderRequest.exchange ? ' on ' + orderRequest.exchange : ''} not found`);
      }

      const contract = searchResponse.data[0];
      const conid = contract.conid;

      // Prepare order object
      const order: any = {
        conid: Number(conid), // Ensure conid is number
        orderType: orderRequest.orderType,
        side: orderRequest.action,
        quantity: Number(orderRequest.quantity), // Ensure quantity is number
        tif: orderRequest.tif || "DAY", // Time in force - default to DAY to avoid orphaned orders
      };

      // Include exchange if specified
      if (orderRequest.exchange) {
        order.exchange = orderRequest.exchange;
      }

      // Add price for limit orders
      if (orderRequest.orderType === "LMT" && orderRequest.price !== undefined) {
        (order as any).price = Number(orderRequest.price);
      }

      // Add stop price for stop orders
      if (orderRequest.orderType === "STP" && orderRequest.stopPrice !== undefined) {
        (order as any).auxPrice = Number(orderRequest.stopPrice);
      }

      // Place the order
      const response = await this.client.post(
        `/iserver/account/${orderRequest.accountId}/orders`,
        {
          orders: [order],
        }
      );

      // Check if we received confirmation messages that need to be handled
      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        const firstResponse = response.data[0];
        
        // Check if this is a confirmation message response
        if (firstResponse.id && firstResponse.message && firstResponse.messageIds && orderRequest.suppressConfirmations) {
          Logger.log("Order confirmation received, automatically confirming...", firstResponse);
          
          // Automatically confirm all messages
          const confirmResponse = await this.confirmOrder(firstResponse.id, firstResponse.messageIds);
          return confirmResponse;
        }
      }

      return response.data;
    } catch (error) {
      Logger.error("Failed to place order:", error);

      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to place orders. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }

      // Preserve the specific "Symbol ... not found" message for callers
      if (error instanceof SymbolNotFoundError) {
        throw error;
      }

      throw new Error("Failed to place order");
    }
  }

  /**
   * Confirm an order by replying to confirmation messages
   * @param replyId The reply ID from the confirmation response
   * @param messageIds Array of message IDs to confirm
   * @returns The confirmation response
   */
  async confirmOrder(replyId: string, messageIds: string[]): Promise<any> {
    try {
      Logger.log(`Confirming order with reply ID ${replyId} and message IDs:`, messageIds);
      
      const response = await this.client.post(`/iserver/reply/${replyId}`, {
        confirmed: true,
        messageIds: messageIds
      });

      Logger.log("Order confirmation response:", response.data);
      return response.data;
    } catch (error) {
      Logger.error("Failed to confirm order:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to confirm orders. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to confirm order: " + (error as any).message);
    }
  }

  async getOrderStatus(orderId: string): Promise<any> {
    try {
      const response = await this.client.get(`/iserver/account/orders/${orderId}`);
      return response.data;
    } catch (error) {
      Logger.error("Failed to get order status:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error(`Authentication required to get order status for order ${orderId}. Please authenticate with Interactive Brokers first.`);
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error(`Failed to get status for order ${orderId}`);
    }
  }

  private normalizeAccountId(account: any): string | undefined {
    if (!account) {
      return undefined;
    }

    if (typeof account === "string") {
      return account.trim() || undefined;
    }

    const id = account.id ?? account.accountId ?? account.account_id ?? account.acctId ?? account.account;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  }

  private extractAccountIds(data: any): string[] {
    const candidates = [
      ...(Array.isArray(data) ? data : []),
      ...(Array.isArray(data?.accounts) ? data.accounts : []),
      ...(Array.isArray(data?.accountIds) ? data.accountIds : []),
      data?.selectedAccount,
      data?.selected_account,
    ];

    return [...new Set(
      candidates
        .map((account) => this.normalizeAccountId(account))
        .filter((accountId): accountId is string => Boolean(accountId))
    )];
  }

  private extractOrders(data: any): any[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (Array.isArray(data?.orders)) {
      return data.orders;
    }

    return [];
  }

  private async getOrderAccountIds(): Promise<string[]> {
    const accountSources = [
      { label: "/iserver/accounts", fetch: () => this.client.get("/iserver/accounts") },
      { label: "/portfolio/accounts", fetch: () => this.client.get("/portfolio/accounts") },
    ];

    for (const source of accountSources) {
      try {
        const response = await source.fetch();
        const accountIds = this.extractAccountIds(response.data);
        if (accountIds.length > 0) {
          return accountIds;
        }
      } catch (error) {
        Logger.warn(`[ORDERS] Failed to discover accounts via ${source.label}:`, error);
      }
    }

    return [];
  }

  async getOrders(accountId?: string): Promise<any> {
    try {
      const url = "/iserver/account/orders";
      
      if (accountId) {
        const response = await this.client.get(url, { params: { accountId } });
        return response.data;
      }

      const accountIds = await this.getOrderAccountIds();
      if (accountIds.length === 0) {
        Logger.warn("[ORDERS] Could not discover account IDs; falling back to unscoped orders request");
        const response = await this.client.get(url, { params: {} });
        return response.data;
      }

      const accountResults = [];
      const orders: any[] = [];

      for (const discoveredAccountId of accountIds) {
        const response = await this.client.get(url, { params: { accountId: discoveredAccountId } });
        accountResults.push({
          accountId: discoveredAccountId,
          data: response.data,
        });
        orders.push(...this.extractOrders(response.data));
      }

      return {
        orders,
        accountResults,
      };
    } catch (error) {
      Logger.error("Failed to get orders:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to retrieve orders. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to retrieve orders");
    }
  }

  /**
   * Get all alerts for an account
   * @param accountId The account ID
   * @returns The list of alerts
   */
  async getAlerts(accountId: string): Promise<any> {
    try {
      Logger.log(`[ALERT] Getting alerts for account ${accountId}`);
      
      const response = await this.client.get(
        `/iserver/account/${accountId}/alerts`
      );

      Logger.log("[ALERT] Get alerts response:", response.data);
      return response.data;
    } catch (error) {
      Logger.error("[ALERT] Failed to get alerts:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to get alerts. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to get alerts: " + (error as any).message);
    }
  }

  /**
   * Create a new alert for an account
   * @param accountId The account ID
   * @param alertRequest The alert configuration
   * @returns The alert creation response
   */
  async createAlert(accountId: string, alertRequest: any): Promise<any> {
    try {
      Logger.log(`[ALERT] Creating alert for account ${accountId}:`, alertRequest);
      
      const response = await this.client.post(
        `/iserver/account/${accountId}/alert`,
        alertRequest
      );

      Logger.log("[ALERT] Alert creation response:", response.data);
      return response.data;
    } catch (error) {
      Logger.error("[ALERT] Failed to create alert:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to create alerts. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to create alert: " + (error as any).message);
    }
  }

  /**
   * Activate an alert
   * @param accountId The account ID
   * @param alertId The alert ID to activate
   * @returns The activation response
   */
  async activateAlert(accountId: string, alertId: string): Promise<any> {
    try {
      Logger.log(`[ALERT] Activating alert ${alertId} for account ${accountId}`);
      
      const response = await this.client.post(
        `/iserver/account/${accountId}/alert/activate`,
        { alertId }
      );

      Logger.log("[ALERT] Alert activation response:", response.data);
      return response.data;
    } catch (error) {
      Logger.error("[ALERT] Failed to activate alert:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to activate alerts. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to activate alert: " + (error as any).message);
    }
  }

  /**
   * Delete an alert
   * @param accountId The account ID
   * @param alertId The alert ID to delete
   * @returns The deletion response
   */
  async deleteAlert(accountId: string, alertId: string): Promise<any> {
    try {
      Logger.log(`[ALERT] Deleting alert ${alertId} for account ${accountId}`);
      
      const response = await this.client.delete(
        `/iserver/account/${accountId}/alert/${alertId}`
      );

      Logger.log("[ALERT] Alert deletion response:", response.data);
      return response.data;
    } catch (error) {
      Logger.error("[ALERT] Failed to delete alert:", error);
      
      // Check if this is likely an authentication error
      if (this.isAuthenticationError(error)) {
        const authError = new Error("Authentication required to delete alerts. Please authenticate with Interactive Brokers first.");
        (authError as any).isAuthError = true;
        throw authError;
      }
      
      throw new Error("Failed to delete alert: " + (error as any).message);
    }
  }
}
