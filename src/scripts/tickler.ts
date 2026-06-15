import { Agent } from "undici";

const args = process.argv.slice(2);
const host = args[0] || "127.0.0.1";
const port = Number(args[1]) || 5000;
const sessionCookieHeader = process.env.IB_TICKLER_COOKIE_HEADER || "";

const baseUrl = `https://${host}:${port}/v1/api`;
const agent = new Agent({ connect: { rejectUnauthorized: false } });

async function request(method: string, path: string): Promise<{ data: any; status: number }> {
  const headers: Record<string, string> = {};
  if (sessionCookieHeader) {
    headers.Cookie = sessionCookieHeader;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(15000),
    dispatcher: agent,
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`) as any;
    error.response = { status: response.status, data };
    throw error;
  }
  return { data, status: response.status };
}

function isStatusAuthenticated(status: unknown): boolean {
  if (!status || typeof status !== "object") {
    return false;
  }
  const statusObj = status as { established?: boolean; authenticated?: boolean; connected?: boolean };
  if (statusObj.established === true) {
    return true;
  }
  return statusObj.authenticated === true && statusObj.connected !== false;
}

async function checkAndTickle(): Promise<boolean> {
  try {
    let tickleResponse: { data: any; status: number };
    try {
      tickleResponse = await request("POST", "/tickle");
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.response?.status === 405) {
        tickleResponse = await request("GET", "/tickle");
      } else {
        throw error;
      }
    }

    const authStatus = tickleResponse.data?.iserver?.authStatus;
    if (authStatus && !isStatusAuthenticated(authStatus)) {
      console.log(`[TICKLER] Tickle returned unauthenticated status. Self-terminating.`);
      return false;
    }

    const statusResponse = await request("GET", "/iserver/auth/status");
    if (!isStatusAuthenticated(statusResponse.data)) {
      console.log(`[TICKLER] Auth status check returned unauthenticated. Self-terminating.`);
      return false;
    }

    console.log(`[TICKLER] Tickle & authentication verified successfully`);
    return true;
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { status?: number } };
    console.error(`[TICKLER] Connection/request error:`, err?.message || String(error));
    if (err?.response?.status === 401) {
      console.log(`[TICKLER] HTTP 401 Unauthorized encountered. Self-terminating.`);
      return false;
    }
    console.log(`[TICKLER] Gateway unreachable or network error. Self-terminating.`);
    return false;
  }
}

async function run() {
  console.log(`[TICKLER] Persistent session tickler started for ${host}:${port} (PID: ${process.pid})`);

  const ok = await checkAndTickle();
  if (!ok) {
    process.exit(0);
  }

  const interval = setInterval(async () => {
    const stillOk = await checkAndTickle();
    if (!stillOk) {
      clearInterval(interval);
      console.log(`[TICKLER] Terminating ticker loop.`);
      process.exit(0);
    }
  }, 30000);
}

run().catch((err) => {
  console.error("[TICKLER] Fatal error in run loop:", err);
  process.exit(1);
});
