import { parseReadOnlyMode } from "./config.js";
import { Logger } from "./logger.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_CLI_FLAGS = new Set([
  "ib-username",
  "ib-password",
  "ib-password-auth",
  "ib-totp-secret",
  "ib-flex-token",
]);

function normalizeFlag(flag: string): string {
  return flag.replace(/^--/, "").split("=", 1)[0].toLowerCase();
}

function isSensitiveFlag(flag: string): boolean {
  const normalized = normalizeFlag(flag);
  return SENSITIVE_CLI_FLAGS.has(normalized)
    || /(?:username|password|totp|secret|token|credential|cookie)/i.test(normalized);
}

export function sanitizeCliArguments(argv: readonly string[]): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.indexOf("=");
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!flag.startsWith("--") || !isSensitiveFlag(flag)) {
      sanitized.push(arg);
      continue;
    }
    if (equals >= 0) {
      sanitized.push(`${flag}=${REDACTED}`);
      continue;
    }
    sanitized.push(flag);
    if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      sanitized.push(REDACTED);
      index++;
    }
  }
  return sanitized;
}

export function redactConfigForLogging<T extends Record<string, unknown>>(config: T): T {
  const seen = new WeakSet<object>();
  const redact = (value: unknown, key = ""): unknown => {
    if (/(?:USERNAME|PASSWORD|TOTP|SECRET|TOKEN|CREDENTIAL|COOKIE)/i.test(key) && value) {
      return REDACTED;
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => redact(entry));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        redact(entry, entryKey),
      ]),
    );
  };
  return redact(config) as T;
}

const STRING_FLAGS: Record<string, string> = {
  "ib-username": "IB_USERNAME",
  "ib-password": "IB_PASSWORD_AUTH",
  "ib-password-auth": "IB_PASSWORD_AUTH",
  "ib-totp-secret": "IB_TOTP_SECRET",
  "ib-flex-token": "IB_FLEX_TOKEN",
  "ib-allowed-account-id": "IB_ALLOWED_ACCOUNT_ID",
};

const NUMBER_FLAGS: Record<string, string> = {
  "ib-auth-timeout": "IB_AUTH_TIMEOUT",
  "ib-auth-wait-seconds": "IB_AUTH_WAIT_SECONDS",
  "ib-auth-poll-seconds": "IB_AUTH_POLL_SECONDS",
};

const BOOLEAN_FLAGS: Record<string, string> = {
  "ib-headless-mode": "IB_HEADLESS_MODE",
  "ib-paper-trading": "IB_PAPER_TRADING",
};

export function parseCliArgs(argv: readonly string[] = process.argv.slice(2)): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  Logger.info(`🔍 Sanitized command line arguments: ${JSON.stringify(sanitizeCliArguments(argv))}`);

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    if (!raw.startsWith("--")) continue;
    const equals = raw.indexOf("=");
    const key = raw.slice(2, equals >= 0 ? equals : undefined);
    let value = equals >= 0 ? raw.slice(equals + 1) : undefined;
    if (value === undefined && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      value = argv[++index];
    }
    Logger.debug(`🔍 Processing CLI flag: ${key}${isSensitiveFlag(key) ? " [REDACTED]" : ""}`);

    if (STRING_FLAGS[key]) {
      if (value !== undefined) args[STRING_FLAGS[key]] = value;
    } else if (NUMBER_FLAGS[key]) {
      if (value !== undefined) args[NUMBER_FLAGS[key]] = Number.parseInt(value, 10);
    } else if (BOOLEAN_FLAGS[key]) {
      args[BOOLEAN_FLAGS[key]] = value === undefined ? true : value.toLowerCase() === "true";
    } else if (key === "ib-read-only-mode") {
      args.IB_READ_ONLY_MODE = value === undefined ? true : parseReadOnlyMode(value);
    }
  }

  Logger.info(`🔍 Parsed args: ${JSON.stringify(redactConfigForLogging(args), null, 2)}`);
  return args;
}
