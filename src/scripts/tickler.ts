import { Agent } from "undici";

import { HttpClient, HttpError } from "../http.js";

interface AuthStatusResponse {
  established?: boolean;
  authenticated?: boolean;
  connected?: boolean;
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

function isStatusAuthenticated(status: unknown): boolean {
  if (!status || typeof status !== "object") {
    return false;
  }

  const statusObj = status as AuthStatusResponse;
  if (statusObj.established === true) {
    return true;
  }

  return statusObj.authenticated === true && statusObj.connected !== false;
}

async function request<T>(method: string, path: string): Promise<TickleResponse> {
  const response = await client.request<T>(method, path);
  return response.data as TickleResponse;
}

async function checkAndTickle(): Promise<boolean> {
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

    const authStatus = tickleResponse.iserver?.authStatus;
    if (authStatus && !isStatusAuthenticated(authStatus)) {
      console.log("[TICKLER] Session no longer authenticated. Self-terminating.");
      return false;
    }

    console.log("[TICKLER] Session tickled and authentication verified successfully");
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.response.status === 401) {
      console.log("[TICKLER] HTTP 401 Unauthorized encountered. Self-terminating.");
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error("[TICKLER] Connection/request error:", message);
    console.log("[TICKLER] Gateway unreachable or network error. Self-terminating.");
    return false;
  }
}

async function run(): Promise<void> {
  console.log(`[TICKLER] Persistent session tickler started for ${host}:${port} (PID: ${process.pid})`);

  const ok = await checkAndTickle();
  if (!ok) {
    process.exit(0);
  }

  const interval = setInterval(async () => {
    const stillOk = await checkAndTickle();
    if (!stillOk) {
      clearInterval(interval);
      console.log("[TICKLER] Terminating ticker loop.");
      process.exit(0);
    }
  }, 30000);
}

run().catch((err) => {
  console.error("[TICKLER] Fatal error in run loop:", err);
  process.exit(1);
});
