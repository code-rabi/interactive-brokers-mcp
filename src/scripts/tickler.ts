import { Agent } from "undici";

import { HttpClient, HttpError } from "../http.js";

interface AuthStatusResponse {
  established?: boolean;
  authenticated?: boolean;
  connected?: boolean;
  competing?: boolean;
}

interface TickleResponse {
  iserver?: {
    authStatus?: AuthStatusResponse;
  };
}

const args = process.argv.slice(2);
const host = args[0] || "127.0.0.1";
const port = Number(args[1]) || 5000;
const sessionCookieHeader = process.env.IB_TICKLER_COOKIE_HEADER || "";

/** Normal cadence. Also the ceiling for backoff: drifting past it risks the session. */
const TICKLE_INTERVAL_MS = 30_000;
/** First retry delay after a failure; doubles up to TICKLE_INTERVAL_MS. */
const BASE_RETRY_MS = 5_000;
/** Roughly 4 minutes of continuous failure before we hand back to the MCP server. */
const MAX_CONSECUTIVE_FAILURES = 10;
/** Cheap cookie-based reauth attempts before a full login (which we cannot do) is needed. */
const MAX_REAUTH_ATTEMPTS = 3;
/** Give the gateway a moment to settle after reauthenticate before re-reading status. */
const REAUTH_SETTLE_MS = 1_000;

const client = new HttpClient({
  baseUrl: `https://${host}:${port}/v1/api`,
  timeout: 15000,
  dispatcher: new Agent({
    connect: {
      rejectUnauthorized: false,
    },
  }),
});

if (sessionCookieHeader) {
  client.setHeader("Cookie", sessionCookieHeader);
}

let consecutiveFailures = 0;
let reauthAttempts = 0;

/** ok: session healthy. transient: retry later. terminal: only a full login can fix this. */
type TickleOutcome = "ok" | "transient" | "terminal";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatusAuthenticated(status: unknown): boolean {
  if (!status || typeof status !== "object") {
    return false;
  }

  const statusObj = status as AuthStatusResponse;
  // A competing session means IBKR handed the brokerage session to another client.
  // The gateway still reports it as established, but requests against it fail.
  if (statusObj.competing === true) {
    return false;
  }

  if (statusObj.established === true) {
    return true;
  }

  return statusObj.authenticated === true && statusObj.connected !== false;
}

async function request<T>(method: string, path: string): Promise<T> {
  const response = await client.request<T>(method, path);
  return response.data;
}

/**
 * The brokerage session dies long before the SSO session does, so a plain
 * reauthenticate usually revives it using the cookies we already hold - no browser
 * and no 2FA. This tickler has no credentials, so this is the only recovery it can
 * perform; anything beyond it has to be escalated to the MCP server.
 */
async function attemptReauthenticate(): Promise<boolean> {
  try {
    await request("POST", "/iserver/reauthenticate");
    await sleep(REAUTH_SETTLE_MS);
    const status = await request<AuthStatusResponse>("GET", "/iserver/auth/status");
    return isStatusAuthenticated(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TICKLER] Reauthenticate request failed:", message);
    return false;
  }
}

async function recoverSession(): Promise<TickleOutcome> {
  reauthAttempts++;

  if (await attemptReauthenticate()) {
    console.log("[TICKLER] Reauthenticate restored the brokerage session");
    reauthAttempts = 0;
    return "ok";
  }

  if (reauthAttempts >= MAX_REAUTH_ATTEMPTS) {
    console.log(
      `[TICKLER] Reauthenticate exhausted after ${reauthAttempts} attempts. ` +
        "A full login with 2FA is required, which this process cannot perform. Self-terminating.",
    );
    return "terminal";
  }

  console.warn(
    `[TICKLER] Reauthenticate attempt ${reauthAttempts}/${MAX_REAUTH_ATTEMPTS} did not restore the session; will retry`,
  );
  return "transient";
}

async function checkAndTickle(): Promise<TickleOutcome> {
  try {
    let tickleResponse: TickleResponse;

    try {
      tickleResponse = await request<TickleResponse>("POST", "/tickle");
    } catch (error) {
      if (error instanceof HttpError && [404, 405].includes(error.response.status)) {
        tickleResponse = await request<TickleResponse>("GET", "/tickle");
      } else {
        throw error;
      }
    }

    if (isStatusAuthenticated(tickleResponse.iserver?.authStatus)) {
      console.log("[TICKLER] Session tickled and authentication verified successfully");
      reauthAttempts = 0;
      return "ok";
    }

    console.log("[TICKLER] Brokerage session is not authenticated; attempting reauthenticate");
    return await recoverSession();
  } catch (error) {
    if (error instanceof HttpError && error.response.status === 401) {
      console.log("[TICKLER] HTTP 401 Unauthorized; attempting reauthenticate");
      return await recoverSession();
    }

    // Connection refused, socket hang-up, gateway restarting, machine asleep. None of
    // these mean the session is gone, so stay alive and retry: exiting here is what
    // silently let the session decay overnight.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TICKLER] Transient connection/request error:", message);
    return "transient";
  }
}

function nextDelayMs(failures: number): number {
  if (failures === 0) {
    return TICKLE_INTERVAL_MS;
  }
  // Back off on repeated failure, but never past the normal cadence: the session
  // needs tickling on time even while we are struggling to reach the gateway.
  return Math.min(TICKLE_INTERVAL_MS, BASE_RETRY_MS * 2 ** (failures - 1));
}

async function run(): Promise<void> {
  console.log(`[TICKLER] Persistent session tickler started for ${host}:${port} (PID: ${process.pid})`);

  for (;;) {
    const outcome = await checkAndTickle();

    if (outcome === "terminal") {
      console.log("[TICKLER] Terminating ticker loop.");
      process.exit(0);
    }

    if (outcome === "ok") {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[TICKLER] ${consecutiveFailures} consecutive failures; the gateway looks unreachable. ` +
            "Self-terminating; the MCP server will respawn a tickler on the next authenticated call.",
        );
        process.exit(0);
      }
    }

    await sleep(nextDelayMs(consecutiveFailures));
  }
}

run().catch((err) => {
  console.error("[TICKLER] Fatal error in run loop:", err);
  process.exit(1);
});
