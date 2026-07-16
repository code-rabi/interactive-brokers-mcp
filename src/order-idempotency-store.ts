import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { OrderRequest } from "./ib-client/types.js";

export type OrderIdempotencyState = "reserved" | "completed" | "uncertain";

export interface OrderIdempotencyRecord {
  clientOrderId: string;
  fingerprint: string;
  state: OrderIdempotencyState;
  response?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface OrderReservation {
  owner: boolean;
  record: OrderIdempotencyRecord;
}

interface StoreDocument {
  version: 1;
  records: Record<string, OrderIdempotencyRecord>;
}

const EMPTY_STORE: StoreDocument = { version: 1, records: {} };
const LOCK_TIMEOUT_MS = 5_000;

export class OrderIdempotencyConflictError extends Error {
  constructor(clientOrderId: string) {
    super(`Client order ID ${clientOrderId} was already used for a different order`);
    this.name = "OrderIdempotencyConflictError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function orderFingerprint(order: OrderRequest): string {
  const normalized: OrderRequest = {
    ...order,
    symbol: order.symbol?.toUpperCase(),
    exchange: order.exchange?.toUpperCase(),
    tif: order.tif ?? "DAY",
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(normalized))).digest("hex");
}

export function defaultOrderIdempotencyStorePath(): string {
  return process.env.IB_ORDER_IDEMPOTENCY_STORE_PATH
    || path.join(homedir(), ".interactive-brokers-mcp", "order-idempotency.json");
}

export class OrderIdempotencyStore {
  readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath = defaultOrderIdempotencyStorePath()) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async reserve(order: OrderRequest): Promise<OrderReservation> {
    const fingerprint = orderFingerprint(order);
    return this.withLock<OrderReservation>(async (document) => {
      const existing = document.records[order.clientOrderId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new OrderIdempotencyConflictError(order.clientOrderId);
        }
        return { value: { owner: false, record: existing }, changed: false };
      }

      const timestamp = new Date().toISOString();
      const record: OrderIdempotencyRecord = {
        clientOrderId: order.clientOrderId,
        fingerprint,
        state: "reserved",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      document.records[order.clientOrderId] = record;
      return { value: { owner: true, record }, changed: true };
    });
  }

  async recordResponse(order: OrderRequest, response: unknown): Promise<OrderIdempotencyRecord> {
    return this.update(order, "completed", { response });
  }

  async recordUncertain(order: OrderRequest, error: unknown): Promise<OrderIdempotencyRecord> {
    return this.update(order, "uncertain", { error });
  }

  async get(clientOrderId: string): Promise<OrderIdempotencyRecord | undefined> {
    const document = await this.readDocument();
    return document.records[clientOrderId];
  }

  private async update(
    order: OrderRequest,
    state: "completed" | "uncertain",
    payload: { response?: unknown; error?: unknown },
  ): Promise<OrderIdempotencyRecord> {
    const fingerprint = orderFingerprint(order);
    return this.withLock(async (document) => {
      const existing = document.records[order.clientOrderId];
      if (!existing || existing.fingerprint !== fingerprint) {
        throw new OrderIdempotencyConflictError(order.clientOrderId);
      }
      const record: OrderIdempotencyRecord = {
        ...existing,
        state,
        ...payload,
        updatedAt: new Date().toISOString(),
      };
      document.records[order.clientOrderId] = record;
      return { value: record, changed: true };
    });
  }

  private async withLock<T>(
    operation: (document: StoreDocument) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = await this.acquireLock();
    try {
      const document = await this.readDocument();
      const result = await operation(document);
      if (result.changed) await this.writeDocument(document);
      return result.value;
    } finally {
      await lock.close();
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(String(process.pid), "utf8");
          await handle.sync();
          return handle;
        } catch (error) {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const ownerPid = Number.parseInt(await readFile(this.lockPath, "utf8"), 10);
          if (Number.isInteger(ownerPid) && !this.isProcessAlive(ownerPid)) {
            await unlink(this.lockPath);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for order store lock ${this.lockPath}`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async readDocument(): Promise<StoreDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as StoreDocument;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error(`Invalid order idempotency store at ${this.filePath}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: EMPTY_STORE.version, records: {} };
      }
      throw error;
    }
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
