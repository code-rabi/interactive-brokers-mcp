import axios from "axios";
import https from "https";

// Extract configuration from arguments
const args = process.argv.slice(2);
const host = args[0] || "127.0.0.1";
const port = Number(args[1]) || 5000;
const sessionCookieHeader = process.env.IB_TICKLER_COOKIE_HEADER || "";

const baseUrl = `https://${host}:${port}/v1/api`;

const client = axios.create({
  baseURL: baseUrl,
  timeout: 15000,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
  }),
  headers: sessionCookieHeader ? { Cookie: sessionCookieHeader } : undefined,
});

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
    // 1. Send tickle request
    const tickleResponse = await client.post("/tickle").catch(async (error) => {
      if (error?.response?.status === 404 || error?.response?.status === 405) {
        return client.get("/tickle");
      }
      throw error;
    });

    // Check authStatus within tickle response
    const authStatus = tickleResponse.data?.iserver?.authStatus;
    if (authStatus && !isStatusAuthenticated(authStatus)) {
      console.log(`[TICKLER] Tickle returned unauthenticated status. Self-terminating.`);
      return false;
    }

    // 2. Perform an explicit status verification check as well
    const statusResponse = await client.get("/iserver/auth/status");
    if (!isStatusAuthenticated(statusResponse.data)) {
      console.log(`[TICKLER] Auth status check returned unauthenticated. Self-terminating.`);
      return false;
    }

    console.log(`[TICKLER] Tickle & authentication verified successfully`);
    return true;
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { status?: number } };
    console.error(`[TICKLER] Connection/request error:`, err?.message || String(error));
    // If it's a 401 unauthenticated error, self-terminate
    if (err?.response?.status === 401) {
      console.log(`[TICKLER] HTTP 401 Unauthorized encountered. Self-terminating.`);
      return false;
    }
    // For network errors or an unreachable gateway, self-terminate and let the main process recreate us after re-authentication.
    console.log(`[TICKLER] Gateway unreachable or network error. Self-terminating.`);
    return false;
  }
}

async function run() {
  console.log(`[TICKLER] Persistent session tickler started for ${host}:${port} (PID: ${process.pid})`);
  
  // Tickle immediately on start
  const ok = await checkAndTickle();
  if (!ok) {
    process.exit(0);
  }

  // Interval of 30 seconds
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
