import { IBClient } from "./ib-client.js";
import { IBGatewayManager } from "./gateway-manager.js";
import { HeadlessAuthenticator, HeadlessAuthConfig } from "./headless-auth.js";
import open from "open";
import { Logger } from "./logger.js";
import { FlexQueryClient } from "./flex-query-client.js";
import { FlexQueryStorage } from "./flex-query-storage.js";
import { OrderPolicy } from "./order-policy.js";
import {
  OrderIdempotencyStore,
  type OrderIdempotencyRecord,
} from "./order-idempotency-store.js";
import {
  AuthenticateInput,
  GetAccountInfoInput,
  GetPositionsInput,
  GetOptionChainInput,
  ResolveOptionConidInput,
  GetMarketDataInput,
  PlaceOrderInput,
  GetOrderStatusInput,
  GetLiveOrdersInput,
  ConfirmOrderInput,
  CancelOrderInput,
  GetAlertsInput,
  CreateAlertInput,
  ActivateAlertInput,
  DeleteAlertInput,
  GetFlexQueryInput,
  ListFlexQueriesInput,
  ForgetFlexQueryInput,
} from "./tool-definitions.js";

export interface ToolHandlerContext {
  ibClient: IBClient;
  gatewayManager?: IBGatewayManager;
  config: any;
  flexQueryClient?: FlexQueryClient;
  flexQueryStorage?: FlexQueryStorage;
  orderIdempotencyStore?: OrderIdempotencyStore;
}

type ToolHandlerResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type AuthGuardResult =
  | { ok: true }
  | { ok: false; result: ToolHandlerResult };

type HeadlessAuthOutcome = {
  success: boolean;
  status?: string;
  message?: string;
  error?: string;
  browserKeptOpen?: boolean;
};

const DEFAULT_AUTH_WAIT_SECONDS = 60;
const DEFAULT_AUTH_POLL_SECONDS = 5;

/**
 * IBKR rate-limits rapid logins and will lock an account that keeps retrying. Without
 * this ceiling a broken login drives a fresh browser session on every tool call.
 */
const MAX_FAILED_LOGINS = 5;

export class ToolHandlers {
  private context: ToolHandlerContext;
  private readonly orderPolicy: OrderPolicy;
  private readonly orderIdempotencyStore: OrderIdempotencyStore;
  private failedLogins = 0;

  constructor(context: ToolHandlerContext) {
    this.context = context;
    this.orderPolicy = new OrderPolicy(context.config);
    this.orderIdempotencyStore = context.orderIdempotencyStore
      ?? new OrderIdempotencyStore(context.config.IB_ORDER_IDEMPOTENCY_STORE_PATH || undefined);
    
    // Initialize flex query client and storage if token is provided
    // Only initialize if not already set (useful for testing)
    if (context.config.IB_FLEX_TOKEN && !context.flexQueryClient) {
      this.context.flexQueryClient = new FlexQueryClient({
        token: context.config.IB_FLEX_TOKEN,
      });
    }
    
    if (context.config.IB_FLEX_TOKEN && !context.flexQueryStorage) {
      this.context.flexQueryStorage = new FlexQueryStorage();
      // Initialize storage asynchronously
      this.context.flexQueryStorage.initialize().catch((error) => {
        Logger.error("[FLEX-QUERY] Failed to initialize storage:", error);
      });
    }
  }

  // Ensure Gateway is ready before operations
  private async ensureGatewayReady(): Promise<void> {
    if (this.context.gatewayManager) {
      await this.context.gatewayManager.ensureGatewayReady();
    }
  }

  private buildAuthUrl(): string {
    const port = this.context.gatewayManager
      ? this.context.gatewayManager.getCurrentPort()
      : this.context.config.IB_GATEWAY_PORT;
    return `https://${this.context.config.IB_GATEWAY_HOST}:${port}`;
  }

  private buildHeadlessAuthConfig(url: string, timeoutMs: number): HeadlessAuthConfig {
    const config = this.context.config;
    return {
      url,
      username: config.IB_USERNAME,
      password: config.IB_PASSWORD_AUTH,
      timeout: timeoutMs,
      ibClient: this.context.ibClient,
      paperTrading: config.IB_PAPER_TRADING,
      twoFaStrategy: config.IB_TWO_FA_STRATEGY,
      totpSecret: config.IB_TOTP_SECRET,
      selectors: {
        username: config.IB_SELECTOR_USERNAME || undefined,
        password: config.IB_SELECTOR_PASSWORD || undefined,
        loginSubmit: config.IB_SELECTOR_LOGIN_SUBMIT || undefined,
        totpInput: config.IB_SELECTOR_TOTP_INPUT || undefined,
        totpSubmit: config.IB_SELECTOR_TOTP_SUBMIT || undefined,
        totpDeviceSelect: config.IB_SELECTOR_TOTP_DEVICE_SELECT || undefined,
      },
    };
  }

  private textResult(text: string): ToolHandlerResult {
    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }

  private jsonResult(payload: unknown): ToolHandlerResult {
    return this.textResult(JSON.stringify(payload, null, 2));
  }

  private getAuthWaitOptions(): { maxWaitSeconds: number; pollSeconds: number } {
    const configuredWait = Number(this.context.config.IB_AUTH_WAIT_SECONDS);
    const configuredPoll = Number(this.context.config.IB_AUTH_POLL_SECONDS);

    const maxWaitSeconds =
      Number.isFinite(configuredWait) && configuredWait >= 0
        ? configuredWait
        : DEFAULT_AUTH_WAIT_SECONDS;
    const pollSeconds =
      Number.isFinite(configuredPoll) && configuredPoll > 0
        ? configuredPoll
        : DEFAULT_AUTH_POLL_SECONDS;

    return { maxWaitSeconds, pollSeconds };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Authentication management
  private async ensureAuth(): Promise<AuthGuardResult> {
    // Ensure Gateway is ready first
    await this.ensureGatewayReady();

    // Check if already authenticated
    let isAuthenticated = await this.context.ibClient.checkAuthenticationStatus();
    if (isAuthenticated) {
      return { ok: true };
    }

    // The brokerage session expires long before the SSO session does, so a plain
    // reauthenticate normally revives it - no browser, no 2FA, and no exposure to
    // IBKR's login rate limits. Try that before paying for a full login. This is the
    // cheap rung of the ladder and it works in browser mode too, where the only other
    // option is to make the user go and click through a login page.
    if (await this.tryReauthenticate()) {
      return { ok: true };
    }

    // If not authenticated, and not in headless mode, throw an error immediately.
    if (!this.context.config.IB_HEADLESS_MODE) {
      const authUrl = this.buildAuthUrl();
      throw new Error(`Authentication required. Please use the 'authenticate' tool to complete the authentication process at ${authUrl}.`);
    }

    // --- Headless Mode Logic ---
    // Validate that we have credentials for headless mode
    if (!this.context.config.IB_USERNAME || !this.context.config.IB_PASSWORD_AUTH) {
      return {
        ok: false,
        result: this.jsonResult({
          success: false,
          status: "AUTHENTICATION_CONFIGURATION_REQUIRED",
          message: "Headless authentication credentials are missing.",
          nextInstruction: "Set IB_USERNAME and IB_PASSWORD_AUTH, then try again.",
        }),
      };
    }
    
    // Stop hammering IBKR once a login is clearly not going to succeed: retrying on
    // every tool call is how an account ends up rate-limited or locked out.
    if (this.failedLogins >= MAX_FAILED_LOGINS) {
      return {
        ok: false,
        result: this.jsonResult({
          success: false,
          status: "AUTHENTICATION_CIRCUIT_OPEN",
          message: `Headless authentication failed ${this.failedLogins} times in a row. Refusing to retry automatically to avoid IBKR rate-limiting or an account lockout.`,
          nextInstruction:
            "Check IB_USERNAME, IB_PASSWORD_AUTH and IB_TOTP_SECRET, then call the 'authenticate' tool to reset the circuit and retry.",
        }),
      };
    }

    // Configuration for the polling loop
    const timeoutSeconds = this.context.config.IB_AUTH_TIMEOUT || 300; // 5 minutes default
    const pollIntervalSeconds = 5;
    const deadline = Date.now() + timeoutSeconds * 1000;

    Logger.info(`⚡ Headless authentication required. Starting process with a ${timeoutSeconds}s timeout.`);

    // Trigger headless authentication once, but don't wait for the promise here.
    // The promise is handled to log results, but the primary flow control is the polling loop.
    const authUrl = this.buildAuthUrl();
    const authConfig = this.buildHeadlessAuthConfig(authUrl, timeoutSeconds * 1000);

    const authenticator = new HeadlessAuthenticator();
    // Fire-and-forget the auth trigger, but handle its completion for logging/cleanup
    authenticator.authenticate(authConfig)
      .then(async (result) => {
        if (!result.browserKeptOpen) {
          await authenticator.close().catch(() => {});
        }
        Logger.info(`🎯 Headless authentication process completed: success=${result.success}`);
      })
      .catch(async (err) => {
        await authenticator.close().catch(() => {});
        Logger.error("❌ Headless authentication process failed:", err);
      });

    // Start the blocking polling loop
    while (Date.now() < deadline) {
      Logger.debug("Polling for authentication status...");
      isAuthenticated = await this.context.ibClient.checkAuthenticationStatus();
      if (isAuthenticated) {
        Logger.info("✅ Authentication successful.");
        this.failedLogins = 0;
        return { ok: true };
      }
      await this.sleep(pollIntervalSeconds * 1000);
    }

    // If the loop completes without success, we've timed out
    this.failedLogins++;
    Logger.error(`❌ Authentication timed out after ${timeoutSeconds} seconds (failure ${this.failedLogins}/${MAX_FAILED_LOGINS}).`);
    throw new Error(`Authentication timed out after ${timeoutSeconds} seconds. Please check for a 2FA notification on your device.`);
  }

  /**
   * Cheapest rung of the recovery ladder: a plain reauthenticate against the gateway,
   * reusing the SSO session we still hold. Costs one HTTP round trip and, unlike a full
   * login, involves no browser, no 2FA and no login rate limit.
   */
  private async tryReauthenticate(): Promise<boolean> {
    try {
      Logger.info("Brokerage session is not authenticated; attempting reauthenticate before a full login.");
      await this.context.ibClient.reauthenticate();
      const recovered = await this.context.ibClient.checkAuthenticationStatus();
      if (recovered) {
        Logger.info("✅ Reauthenticate restored the brokerage session; skipping full login.");
        this.failedLogins = 0;
      } else {
        Logger.info("Reauthenticate did not restore the session; a full login is required.");
      }
      return recovered;
    } catch (error) {
      Logger.warn("Reauthenticate failed; falling back to a full login:", error);
      return false;
    }
  }

  /**
   * Transport failures that mean "the connection died", not "the request was rejected".
   * A dropped socket to the gateway is recoverable by re-establishing the session, so it
   * has to be classified as an auth error - otherwise it surfaces raw to the caller and
   * the recovery path in ensureAuth never runs.
   */
  private isTransportError(error: any): boolean {
    const code = error?.code || error?.cause?.code;
    if (
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true;
    }

    const message = String(error?.message || "");
    return (
      message.includes("stream was destroyed") ||
      message.includes("socket hang up") ||
      message.includes("other side closed") ||
      message.includes("fetch failed")
    );
  }

  // Helper function to check for authentication errors
  private isAuthenticationError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message || error.toString();
    const errorStatus = error.response?.status;
    const responseData = error.response?.data;

    return (
      errorStatus === 401 ||
      errorStatus === 403 ||
      errorStatus === 500 ||
      this.isTransportError(error) ||
      errorMessage.includes("authentication") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("not authenticated") ||
      errorMessage.includes("login") ||
      responseData?.error === "not authenticated"
    );
  }

  private getAuthenticationErrorMessage(): string {
    const authUrl = this.buildAuthUrl();
    const mode = this.context.config.IB_HEADLESS_MODE ? "headless mode" : "browser mode";
    return `Authentication required. Please use the 'authenticate' tool to complete the authentication process (configured for ${mode}) at ${authUrl}.`;
  }

  /**
   * After browser opens for OAuth, poll the gateway until authenticated,
   * then trigger reauthenticate to establish the REST API session.
   * This bridges the gap between browser-based OAuth and the REST API auth state.
   *
   * Polling is bounded by a deadline (~2 minutes from start) rather than by attempt
   * count, so the upper bound matches the documented timeout regardless of backoff.
   */
  private startBrowserAuthPolling(authUrl: string, port: number): void {
    const pollWindowMs = 120_000; // 2 minutes total
    const initialDelay = 2000; // 2 second initial delay
    const maxDelay = 10_000;
    const deadline = Date.now() + pollWindowMs;
    let attempts = 0;

    const poll = async () => {
      attempts++;
      Logger.log(`[BROWSER-AUTH-POLL] Polling ${authUrl} (port ${port}) attempt ${attempts} until ${new Date(deadline).toISOString()}`);

      try {
        if (typeof this.context.ibClient.initializeBrokerageSession === "function") {
          const initialized = await this.context.ibClient.initializeBrokerageSession();
          if (initialized) {
            Logger.log(`[BROWSER-AUTH-POLL] Brokerage session initialized for ${authUrl} (port ${port})`);
            return; // Success, stop polling
          }
        } else {
          const isAuth = await this.context.ibClient.checkAuthenticationStatus();
          if (isAuth) {
            Logger.log(`[BROWSER-AUTH-POLL] Authentication detected for ${authUrl} (port ${port}), reauthenticating REST session`);
            await this.context.ibClient.reauthenticate();
            Logger.log(`[BROWSER-AUTH-POLL] Reauthentication successful for ${authUrl} (port ${port}), REST session established`);
            return; // Success, stop polling
          }
        }
      } catch (error) {
        Logger.warn(`[BROWSER-AUTH-POLL] Poll attempt ${attempts} failed for ${authUrl} (port ${port}):`, error);
      }

      const delay = Math.min(initialDelay + (attempts * 500), maxDelay);
      if (Date.now() + delay < deadline) {
        setTimeout(poll, delay);
      } else {
        Logger.warn(`[BROWSER-AUTH-POLL] Timed out waiting for browser authentication at ${authUrl} (port ${port}) after ${attempts} attempts`);
      }
    };

    // Start polling after initial delay
    setTimeout(poll, initialDelay);
  }

  private formatError(error: unknown): string {
    if (this.isAuthenticationError(error)) {
      return this.getAuthenticationErrorMessage();
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `Error: ${errorMessage}`;
  }

  private orderSubmissionErrorPayload(error: unknown): {
    code: "SUBMISSION_UNCERTAIN" | "ORDER_SUBMISSION_FAILED";
    message: string;
    status?: number;
    ibkrBody?: unknown;
    transportCode?: string;
    submissionUncertain: boolean;
  } | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as Record<string, unknown>;
    if (candidate.name !== "OrderSubmissionError" && typeof candidate.submissionUncertain !== "boolean") {
      return undefined;
    }
    const uncertain = candidate.submissionUncertain === true;
    return {
      code: uncertain ? "SUBMISSION_UNCERTAIN" : "ORDER_SUBMISSION_FAILED",
      message: error instanceof Error ? error.message : "Order submission failed",
      status: typeof candidate.status === "number" ? candidate.status : undefined,
      ibkrBody: candidate.ibkrBody,
      transportCode: typeof candidate.transportCode === "string" ? candidate.transportCode : undefined,
      submissionUncertain: uncertain,
    };
  }

  private orderCancellationErrorPayload(error: unknown): {
    code: "ORDER_CANCELLATION_FAILED";
    message: string;
    status: number;
    ibkrBody: unknown;
  } | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as Record<string, unknown>;
    if (candidate.name !== "OrderCancellationError" || typeof candidate.status !== "number") {
      return undefined;
    }
    return {
      code: "ORDER_CANCELLATION_FAILED",
      message: error instanceof Error ? error.message : "Order cancellation failed",
      status: candidate.status,
      ibkrBody: candidate.ibkrBody,
    };
  }

  private replayOrderRecord(record: OrderIdempotencyRecord): ToolHandlerResult {
    if (record.state === "completed") return this.jsonResult(record.response);
    return this.jsonResult({
      code: "SUBMISSION_UNCERTAIN",
      message: "This clientOrderId may already have been submitted. Check IBKR live orders and executions manually before taking any further action.",
      submissionUncertain: true,
      persistedRecord: record,
      manualReconciliation: [
        "Search IBKR live orders and executions for this clientOrderId.",
        "Do not submit a replacement order automatically.",
      ],
    });
  }

  private persistenceErrorPayload(error: unknown): { name: string; message: string; code?: string } {
    const candidate = error && typeof error === "object"
      ? error as { name?: unknown; message?: unknown; code?: unknown }
      : undefined;
    return {
      name: typeof candidate?.name === "string" ? candidate.name : "Error",
      message: typeof candidate?.message === "string" ? candidate.message : String(error),
      code: typeof candidate?.code === "string" ? candidate.code : undefined,
    };
  }

  private uncertainPersistencePayload(brokerResponse: unknown, persistenceError: unknown) {
    return {
      code: "SUBMISSION_UNCERTAIN" as const,
      message: "IBKR returned a response, but its terminal result could not be persisted. Check IBKR manually before taking any further action.",
      submissionUncertain: true,
      brokerResponse,
      persistenceError: this.persistenceErrorPayload(persistenceError),
      manualReconciliation: [
        "Search IBKR live orders and executions for this clientOrderId.",
        "Use brokerResponse to match the IBKR order or reply ID.",
        "Do not submit a replacement order automatically.",
      ],
    };
  }

  async authenticate(input: AuthenticateInput): Promise<ToolHandlerResult> {
    try {
      // An explicit authenticate call is the caller asserting they have fixed whatever
      // was broken, so it resets the circuit breaker that ensureAuth may have opened.
      this.failedLogins = 0;

      // Ensure Gateway is ready
      await this.ensureGatewayReady();

      const port = this.context.gatewayManager 
        ? this.context.gatewayManager.getCurrentPort() 
        : this.context.config.IB_GATEWAY_PORT;
      const authUrl = `https://${this.context.config.IB_GATEWAY_HOST}:${port}`;
      
      // Check if headless mode is enabled in config
      if (this.context.config.IB_HEADLESS_MODE) {
        try {
          // Use headless authentication
          const authConfig = this.buildHeadlessAuthConfig(authUrl, this.context.config.IB_AUTH_TIMEOUT);

          // Validate that we have credentials for headless mode
          if (!authConfig.username || !authConfig.password) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    message: "Headless mode enabled but authentication credentials missing",
                    error: "Please set IB_USERNAME and IB_PASSWORD_AUTH environment variables for headless authentication",
                    authUrl: authUrl,
                    instructions: [
                      "Set environment variables: IB_USERNAME and IB_PASSWORD_AUTH",
                      "Or disable headless mode by setting IB_HEADLESS_MODE=false",
                      "Then try authentication again"
                    ]
                  }, null, 2),
                },
              ],
            };
          }

          const authenticator = new HeadlessAuthenticator();
          const result = await authenticator.authenticate(authConfig);

          // Keep the browser alive only when the authenticator reports a user-action
          // 2FA state that can still be completed after this tool response.
          if (!result.browserKeptOpen) {
            await authenticator.close();
          }
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...result,
                  authUrl: authUrl,
                  mode: "headless",
                  note: "Headless authentication completed automatically"
                }, null, 2),
              },
            ],
          };

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  message: "Headless authentication failed, falling back to manual browser authentication",
                  error: errorMessage,
                  authUrl: authUrl,
                  mode: "fallback_to_manual",
                  note: "Opening browser for manual authentication..."
                }, null, 2),
              },
            ],
          };
        }
      }
      
      // Original browser-based authentication (when headless mode is disabled or as fallback)
      try {
        await open(authUrl);
        
        // Start polling for authentication to complete
        // The browser auth creates a server-side session that the REST API can use
        // We poll until authenticated, then trigger reauthenticate for the REST session
        this.startBrowserAuthPolling(authUrl, port);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Interactive Brokers authentication interface opened in your browser",
                authUrl: authUrl,
                mode: "browser",
                instructions: [
                  "1. The authentication page has been opened in your default browser",
                  "2. Accept any SSL certificate warnings (this is normal for localhost)",
                  "3. Complete the authentication process in the IB Gateway web interface",
                  "4. Log in with your Interactive Brokers credentials",
                  "5. Once authenticated, you can use other trading tools"
                ],
                browserOpened: true,
                polling: true,
                note: "IB Gateway is running locally - your credentials stay secure on your machine. Polling for authentication completion..."
              }, null, 2),
            },
          ],
        };
      } catch (browserError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Opening Interactive Brokers authentication interface...",
                authUrl: authUrl,
                mode: "manual",
                instructions: [
                  "1. Open the authentication URL below in your browser:",
                  `   ${authUrl}`,
                  "2. Accept any SSL certificate warnings (this is normal for localhost)",
                  "3. Complete the authentication process",
                  "4. Log in with your Interactive Brokers credentials",
                  "5. Once authenticated, you can use other trading tools"
                ],
                browserOpened: false,
                note: "Please open the URL manually. IB Gateway is running locally."
              }, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getAccountInfo(input: GetAccountInfoInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getAccountInfo();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getPositions(input: GetPositionsInput): Promise<ToolHandlerResult> {
    if (!input.accountId) {
      return {
        content: [
          {
            type: "text",
            text: "Account ID is required",
          },
        ],
      };
    }
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getPositions(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getMarketData(input: GetMarketDataInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getMarketData(input.symbol, input.exchange);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getOptionChain(input: GetOptionChainInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getOptionChain(input.symbol, input.exchange);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async resolveOptionConid(input: ResolveOptionConidInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.resolveOptionConid(
        input.symbol,
        input.expiry,
        input.strike,
        input.right,
        input.exchange,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<ToolHandlerResult> {
    let order: ReturnType<OrderPolicy["validatePlaceOrder"]> | undefined;
    try {
      order = this.orderPolicy.validatePlaceOrder(input);
      const auth = await this.ensureAuth();
      if (!auth.ok) {
        return auth.result;
      }
      const existing = await this.orderIdempotencyStore.lookup(order);
      if (existing) return this.replayOrderRecord(existing);
      // Resolve and validate the contract before consuming the durable ID. The
      // reservation is intentionally adjacent to the only side-effecting POST.
      const prepared = await this.context.ibClient.prepareOrder(order);
      const reservation = await this.orderIdempotencyStore.reserve(order);
      if (!reservation.owner) return this.replayOrderRecord(reservation.record);

      let result: unknown;
      try {
        result = await this.context.ibClient.submitPreparedOrder(prepared);
      } catch (submissionError) {
        const payload = this.orderSubmissionErrorPayload(submissionError) ?? {
          code: "SUBMISSION_UNCERTAIN" as const,
          message: `Order submission outcome is uncertain: ${submissionError instanceof Error ? submissionError.message : String(submissionError)}`,
          submissionUncertain: true,
        };
        if (payload.submissionUncertain) {
          await this.orderIdempotencyStore.recordUncertain(order, payload).catch(() => undefined);
        } else {
          await this.orderIdempotencyStore.recordResponse(order, payload).catch(() => undefined);
        }
        return this.jsonResult(payload);
      }

      try {
        await this.orderIdempotencyStore.recordResponse(order, result);
      } catch (persistenceError) {
        const uncertain = this.uncertainPersistencePayload(result, persistenceError);
        await this.orderIdempotencyStore.recordUncertain(order, uncertain).catch(() => undefined);
        return this.jsonResult(uncertain);
      }
      return this.jsonResult(result);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getOrderStatus(input: GetOrderStatusInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getOrderStatus(input.orderId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getLiveOrders(input: GetLiveOrdersInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      // Pass accountId as query parameter if provided
      const result = await this.context.ibClient.getOrders(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async confirmOrder(input: ConfirmOrderInput): Promise<ToolHandlerResult> {
    try {
      this.orderPolicy.assertWriteEnabled();
      const auth = await this.ensureAuth();
      if (!auth.ok) {
        return auth.result;
      }
      const result = await this.context.ibClient.confirmOrder(input.replyId, input.messageIds);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async cancelOrder(input: CancelOrderInput): Promise<ToolHandlerResult> {
    try {
      this.orderPolicy.assertAllowedAccount(input.accountId);
      const auth = await this.ensureAuth();
      if (!auth.ok) return auth.result;
      return this.jsonResult(await this.context.ibClient.cancelOrder(input.accountId, input.orderId));
    } catch (error) {
      const structured = this.orderCancellationErrorPayload(error);
      return structured ? this.jsonResult(structured) : this.textResult(this.formatError(error));
    }
  }

  async getAlerts(input: GetAlertsInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getAlerts(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async createAlert(input: CreateAlertInput): Promise<ToolHandlerResult> {
    try {
      this.orderPolicy.assertAllowedAccount(input.accountId);
      const auth = await this.ensureAuth();
      if (!auth.ok) {
        return auth.result;
      }
      const result = await this.context.ibClient.createAlert(input.accountId, input.alertRequest);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async activateAlert(input: ActivateAlertInput): Promise<ToolHandlerResult> {
    try {
      this.orderPolicy.assertAllowedAccount(input.accountId);
      const auth = await this.ensureAuth();
      if (!auth.ok) {
        return auth.result;
      }
      const result = await this.context.ibClient.activateAlert(input.accountId, input.alertId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async deleteAlert(input: DeleteAlertInput): Promise<ToolHandlerResult> {
    try {
      this.orderPolicy.assertAllowedAccount(input.accountId);
      const auth = await this.ensureAuth();
      if (!auth.ok) {
        return auth.result;
      }
      const result = await this.context.ibClient.deleteAlert(input.accountId, input.alertId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  // ── Flex Query Methods ──────────────────────────────────────────────────────

  async getFlexQuery(input: GetFlexQueryInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryClient) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries",
                instructions: [
                  "1. Get your Flex Web Service Token from Interactive Brokers",
                  "2. Set the IB_FLEX_TOKEN environment variable",
                  "3. Restart the MCP server"
                ]
              }, null, 2),
            },
          ],
        };
      }

      if (!this.context.flexQueryStorage) {
        throw new Error("Flex Query storage not initialized");
      }

      Logger.log(`[FLEX-QUERY] Executing flex query: ${input.queryId}`);

      // Check if this query was used before (by IB's query ID)
      const existingQuery = await this.context.flexQueryStorage.getQueryByQueryId(input.queryId);
      
      // Execute the query
      const result = await this.context.flexQueryClient.executeQuery(input.queryId);

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: result.error,
                errorCode: result.errorCode,
                queryId: input.queryId,
              }, null, 2),
            },
          ],
        };
      }

      // Parse XML to extract query name from the response
      let parsedData;
      let queryNameFromApi: string | undefined;
      
      if (result.data) {
        try {
          parsedData = await this.context.flexQueryClient.parseStatement(result.data);
          
          // Extract query name from the parsed XML
          // The queryName is directly under FlexQueryResponse
          if (parsedData?.FlexQueryResponse) {
            queryNameFromApi = parsedData.FlexQueryResponse.queryName;
          }
          
          Logger.log(`[FLEX-QUERY] Extracted query name from API: ${queryNameFromApi}`);
        } catch (parseError) {
          Logger.warn("[FLEX-QUERY] Failed to parse XML for query name extraction:", parseError);
        }
      }

      // Auto-save the query if it's new or update last used
      if (existingQuery) {
        await this.context.flexQueryStorage.markQueryUsed(existingQuery.id);
        Logger.log(`[FLEX-QUERY] Updated last used timestamp for query: ${input.queryId}`);
      } else {
        // Save new query with the name from API, input, or fallback to queryId
        const queryName = queryNameFromApi || input.queryName || input.queryId;
        await this.context.flexQueryStorage.saveQuery({
          name: queryName,
          queryId: input.queryId,
          description: `Auto-saved on ${new Date().toLocaleDateString()}`,
        });
        Logger.log(`[FLEX-QUERY] Auto-saved new query: ${queryName}`);
      }

      // Return parsed data if requested (and we haven't parsed it yet)
      if (input.parseXml && !parsedData && result.data) {
        try {
          parsedData = await this.context.flexQueryClient.parseStatement(result.data);
        } catch (parseError) {
          Logger.warn("[FLEX-QUERY] Failed to parse XML, returning raw data:", parseError);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              queryId: input.queryId,
              queryName: queryNameFromApi,
              autoSaved: !existingQuery,
              data: parsedData || result.data,
              note: existingQuery 
                ? "Query was previously saved and has been marked as used" 
                : "Query has been automatically saved for future reference"
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async listFlexQueries(input: ListFlexQueriesInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryStorage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries"
              }, null, 2),
            },
          ],
        };
      }

      const queries = await this.context.flexQueryStorage.listQueries();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: queries.length,
              queries: queries.map(q => ({
                name: q.name,
                queryId: q.queryId,
                description: q.description,
                createdAt: q.createdAt,
                lastUsed: q.lastUsed,
              })),
              storageLocation: this.context.flexQueryStorage.getStorageFilePath(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async forgetFlexQuery(input: ForgetFlexQueryInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryStorage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries"
              }, null, 2),
            },
          ],
        };
      }

      // Try to find the query by IB's queryId first, then by name as fallback
      let query = await this.context.flexQueryStorage.getQueryByQueryId(input.queryId);
      
      if (!query) {
        // Try to find by name as fallback (in case user provides a friendly name)
        query = await this.context.flexQueryStorage.getQueryByName(input.queryId);
      }

      if (!query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Query not found",
                message: `No saved query found with ID: ${input.queryId}`,
                suggestion: "Use list_flex_queries to see all saved queries"
              }, null, 2),
            },
          ],
        };
      }

      const deleted = await this.context.flexQueryStorage.deleteQuery(query.id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: deleted,
              message: deleted 
                ? `Query "${query.name}" (${query.queryId}) has been forgotten` 
                : "Failed to delete query",
              queryId: input.queryId,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }
}
