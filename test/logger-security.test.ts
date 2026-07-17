import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Logger order-error security", () => {
  it("tightens an existing log before appending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ib-mcp-logger-existing-"));
    dirs.push(root);
    const logDir = path.join(root, "logs");
    const logFile = path.join(logDir, "ib-mcp.log");
    await mkdir(logDir, { recursive: true });
    await writeFile(logFile, "old\n", { mode: 0o644 });
    await chmod(logFile, 0o644);
    const script = "const { Logger } = await import('./src/logger.ts'); Logger.info('new-secret-free-line');";
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, IB_MCP_LOG_DIR: logDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);
    expect((await stat(logFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(logFile, "utf8")).toContain("new-secret-free-line");
  });

  it("uses private modes and does not log the raw IBKR body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ib-mcp-logger-"));
    dirs.push(root);
    const logDir = path.join(root, "logs");
    const script = [
      "const { IBClient } = await import('./src/ib-client.ts');",
      "let request = 0;",
      "globalThis.fetch = async () => {",
      "  if (request++ % 2 === 0) return new Response(JSON.stringify({ conid: 265598, symbol: 'AAPL', secType: 'STK', currency: 'USD' }));",
      "  if (request === 2) return new Response(JSON.stringify({ error: 'Order rejected', errorCode: 201, secret: 'DO_NOT_LOG' }), { status: 400 });",
      "  return new Response(JSON.stringify([{ id: 'order-123', secret: 'DO_NOT_LOG_SUCCESS' }]));",
      "};",
      "const client = new IBClient({ host: 'localhost', port: 5000 });",
      "client.isAuthenticated = true;",
      "await client.placeOrder({ clientOrderId: 'log-security', accountId: 'U12345', conid: 265598, action: 'BUY', orderType: 'LMT', quantity: 1, price: 10 }).catch(() => undefined);",
      "await client.placeOrder({ clientOrderId: 'log-security-success', accountId: 'U12345', conid: 265598, action: 'BUY', orderType: 'LMT', quantity: 1, price: 10 });",
      "client.destroy();",
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, IB_MCP_LOG_DIR: logDir, IB_MCP_CONSOLE_LOGGING: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(Buffer.concat(stderr).toString()).toBe("");
    expect(exitCode).toBe(0);

    const logFile = path.join(logDir, "ib-mcp.log");
    expect((await stat(logDir)).mode & 0o777).toBe(0o700);
    expect((await stat(logFile)).mode & 0o777).toBe(0o600);
    const contents = await readFile(logFile, "utf8");
    expect(contents).toContain('"status":400');
    expect(contents).not.toContain("DO_NOT_LOG");
    expect(contents).not.toContain("DO_NOT_LOG_SUCCESS");
  });
});
