import { createHash, randomUUID } from "node:crypto";
import {
  mkdir as fsMkdir,
  chmod as fsChmod,
  link as fsLink,
  open as fsOpen,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
const LOCK_INITIALIZATION_GRACE_MS = 1_000;

interface OrderStoreFileSystem {
  chmod: typeof fsChmod;
  link: typeof fsLink;
  mkdir: typeof fsMkdir;
  open: typeof fsOpen;
  readFile: typeof fsReadFile;
  rename: typeof fsRename;
  stat: typeof fsStat;
  unlink: typeof fsUnlink;
}

export interface OrderIdempotencyStoreOptions {
  fileSystem?: Partial<OrderStoreFileSystem>;
  lockInitializationGraceMs?: number;
}

interface LockOwnership {
  inode: number;
  metadata: string;
  ownerPath: string;
}

const defaultFileSystem: OrderStoreFileSystem = {
  chmod: fsChmod,
  link: fsLink,
  mkdir: fsMkdir,
  open: fsOpen,
  readFile: fsReadFile,
  rename: fsRename,
  stat: fsStat,
  unlink: fsUnlink,
};

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
  private readonly fileSystem: OrderStoreFileSystem;
  private readonly lockInitializationGraceMs: number;

  constructor(
    filePath = defaultOrderIdempotencyStorePath(),
    options: OrderIdempotencyStoreOptions = {},
  ) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    this.lockInitializationGraceMs = options.lockInitializationGraceMs
      ?? LOCK_INITIALIZATION_GRACE_MS;
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

  async lookup(order: OrderRequest): Promise<OrderIdempotencyRecord | undefined> {
    const existing = await this.get(order.clientOrderId);
    if (existing && existing.fingerprint !== orderFingerprint(order)) {
      throw new OrderIdempotencyConflictError(order.clientOrderId);
    }
    return existing;
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
    await this.fileSystem.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.fileSystem.chmod(path.dirname(this.filePath), 0o700);
    await this.fileSystem.chmod(this.filePath, 0o600).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    const lock = await this.acquireLock();
    try {
      const document = await this.readDocument();
      const result = await operation(document);
      if (result.changed) await this.writeDocument(document);
      return result.value;
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async acquireLock(): Promise<LockOwnership> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      let contentionError: unknown;
      const token = randomUUID();
      const ownerPath = `${this.lockPath}.${process.pid}.${token}.owner`;
      const metadata = JSON.stringify({ pid: process.pid, token });
      try {
        const handle = await this.fileSystem.open(ownerPath, "wx", 0o600);
        let ownerInode = 0;
        try {
          await this.writeAndClose(handle, async () => {
            await handle.writeFile(metadata, "utf8");
            await handle.sync();
            ownerInode = Number((await handle.stat()).ino);
          });
        } catch (error) {
          await this.fileSystem.unlink(ownerPath).catch(() => undefined);
          throw error;
        }
        try {
          // hard-link publication is atomic: the canonical path is either absent or
          // points at a fully written, fsynced owner metadata file.
          await this.fileSystem.link(ownerPath, this.lockPath);
          await this.fileSystem.unlink(ownerPath).catch(() => undefined);
          return { inode: ownerInode, metadata, ownerPath };
        } catch (error) {
          await this.fileSystem.unlink(ownerPath).catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          contentionError = error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        contentionError = error;
      }
      try {
        if (await this.recoverAbandonedLock()) {
          continue;
        }
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw recoveryError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for order store lock ${this.lockPath}`, { cause: contentionError });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async writeAndClose(handle: FileHandle, write: () => Promise<void>): Promise<void> {
    let primaryError: unknown;
    try {
      await write();
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await handle.close();
      } catch (closeError) {
        if (primaryError === undefined) primaryError = closeError;
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }

  private async recoverAbandonedLock(): Promise<boolean> {
    const initialStat = await this.fileSystem.stat(this.lockPath);
    if (Date.now() - initialStat.mtimeMs < this.lockInitializationGraceMs) return false;

    const metadata = await this.fileSystem.readFile(this.lockPath, "utf8");
    let owner: { pid?: unknown; token?: unknown } | undefined;
    try {
      owner = JSON.parse(metadata) as { pid?: unknown; token?: unknown };
    } catch {
      owner = undefined;
    }
    if (
      owner
      && Number.isInteger(owner.pid)
      && typeof owner.token === "string"
      && this.isProcessAlive(owner.pid as number)
    ) {
      return false;
    }
    return this.unlinkIfUnchanged(Number(initialStat.ino), metadata);
  }

  private async releaseLock(lock: LockOwnership): Promise<void> {
    let releaseError: unknown;
    try {
      await this.unlinkIfUnchanged(lock.inode, lock.metadata);
    } catch (error) {
      releaseError = error;
    } finally {
      try {
        await this.unlinkAliasIfOwned(lock.ownerPath, lock.inode, lock.metadata);
      } catch (aliasError) {
        if (releaseError === undefined) releaseError = aliasError;
      }
    }
    if (releaseError !== undefined) throw releaseError;
  }

  private async unlinkAliasIfOwned(
    aliasPath: string,
    expectedInode: number,
    expectedMetadata: string,
  ): Promise<boolean> {
    try {
      const before = await this.fileSystem.stat(aliasPath);
      if (Number(before.ino) !== expectedInode) return false;
      const metadata = await this.fileSystem.readFile(aliasPath, "utf8");
      const after = await this.fileSystem.stat(aliasPath);
      if (Number(after.ino) !== expectedInode || metadata !== expectedMetadata) return false;
      await this.fileSystem.unlink(aliasPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async unlinkIfUnchanged(expectedInode: number, expectedMetadata: string): Promise<boolean> {
    const before = await this.fileSystem.stat(this.lockPath);
    if (Number(before.ino) !== expectedInode) return false;
    const metadata = await this.fileSystem.readFile(this.lockPath, "utf8");
    const after = await this.fileSystem.stat(this.lockPath);
    if (Number(after.ino) !== expectedInode || metadata !== expectedMetadata) return false;
    await this.fileSystem.unlink(this.lockPath);
    return true;
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
      const parsed = JSON.parse(await this.fileSystem.readFile(this.filePath, "utf8")) as StoreDocument;
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
    const handle = await this.fileSystem.open(tempPath, "wx", 0o600);
    let renamed = false;
    try {
      await this.writeAndClose(handle, async () => {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await handle.sync();
      });
      await this.fileSystem.rename(tempPath, this.filePath);
      renamed = true;
      await this.fileSystem.chmod(this.filePath, 0o600);
      await this.syncParentDirectory();
    } catch (error) {
      if (!renamed) await this.fileSystem.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async syncParentDirectory(): Promise<void> {
    const directory = await this.fileSystem.open(path.dirname(this.filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
