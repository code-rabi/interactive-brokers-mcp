import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs, redactConfigForLogging, sanitizeCliArguments } from "../src/cli-args.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("CLI argument parsing and logging", () => {
  it("parses read-only and account settings in space and equals forms", () => {
    expect(parseCliArgs(["--ib-read-only-mode", "false", "--ib-allowed-account-id", "U12345"]))
      .toMatchObject({ IB_READ_ONLY_MODE: false, IB_ALLOWED_ACCOUNT_ID: "U12345" });
    expect(parseCliArgs(["--ib-read-only-mode=false", "--ib-allowed-account-id=U67890"]))
      .toMatchObject({ IB_READ_ONLY_MODE: false, IB_ALLOWED_ACCOUNT_ID: "U67890" });
  });

  it("redacts every credential form, including username, TOTP and flex token", () => {
    const secrets = ["USERVALUE_923", "PASSVALUE_923", "AUTHVALUE_923", "TOTPVALUE_923", "FLEXVALUE_923"];
    const sanitized = sanitizeCliArguments([
      "--ib-username", secrets[0],
      `--ib-password=${secrets[1]}`,
      "--ib-password-auth", secrets[2],
      `--ib-totp-secret=${secrets[3]}`,
      "--ib-flex-token", secrets[4],
    ]);
    const serialized = JSON.stringify(sanitized);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized.match(/\[REDACTED\]/g)).toHaveLength(5);
  });

  it("redacts nested authentication configuration consistently", () => {
    const redacted = redactConfigForLogging({
      username: "PRIVATE_USER",
      password: "PRIVATE_PASSWORD",
      totpSecret: "PRIVATE_TOTP",
      nested: { flexToken: "PRIVATE_FLEX", safe: "visible" },
    });
    expect(redacted).toEqual({
      username: "[REDACTED]",
      password: "[REDACTED]",
      totpSecret: "[REDACTED]",
      nested: { flexToken: "[REDACTED]", safe: "visible" },
    });
  });

  it("never writes CLI secrets to the real startup log", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ib-mcp-cli-log-"));
    dirs.push(root);
    const secrets = ["SPACE_USER_VALUE_923", "EQUAL_PASSWORD_VALUE_923", "TOTP_VALUE_923", "FLEX_VALUE_923"];
    const script = [
      "const { parseCliArgs } = await import('./src/cli-args.ts');",
      `parseCliArgs(${JSON.stringify([
        "--ib-username", secrets[0],
        `--ib-password-auth=${secrets[1]}`,
        "--ib-totp-secret", secrets[2],
        `--ib-flex-token=${secrets[3]}`,
        "--ib-read-only-mode=false",
        "--ib-allowed-account-id=U12345",
      ])});`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, IB_MCP_LOG_DIR: root, IB_MCP_CONSOLE_LOGGING: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);
    const log = await readFile(path.join(root, "ib-mcp.log"), "utf8");
    for (const secret of secrets) expect(log).not.toContain(secret);
    expect(log).toContain("[REDACTED]");
  });
});
