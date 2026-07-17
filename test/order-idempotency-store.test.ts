import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrderIdempotencyConflictError,
  OrderIdempotencyStore,
} from "../src/order-idempotency-store.js";

const dirs: string[] = [];

async function makeStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ib-mcp-orders-"));
  dirs.push(dir);
  return path.join(dir, "orders.json");
}

const request = {
  clientOrderId: "codex-durable-001",
  accountId: "U12345",
  symbol: "AAPL",
  action: "BUY" as const,
  orderType: "LMT" as const,
  quantity: 2,
  price: 201.5,
  tif: "DAY" as const,
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OrderIdempotencyStore", () => {
  it("returns an identical completed record after restart", async () => {
    const file = await makeStorePath();
    const first = new OrderIdempotencyStore(file);
    const reservation = await first.reserve(request);
    expect(reservation.owner).toBe(true);
    await first.recordResponse(request, [{ id: "order-123", status: "Submitted" }]);

    const restarted = new OrderIdempotencyStore(file);
    const replay = await restarted.reserve({ ...request, tif: undefined });

    expect(replay).toMatchObject({
      owner: false,
      record: {
        clientOrderId: request.clientOrderId,
        state: "completed",
        response: [{ id: "order-123", status: "Submitted" }],
      },
    });
  });

  it("rejects conflicting reuse of a client order ID", async () => {
    const store = new OrderIdempotencyStore(await makeStorePath());
    await store.reserve(request);

    await expect(store.reserve({ ...request, quantity: 3 })).rejects.toBeInstanceOf(
      OrderIdempotencyConflictError,
    );
  });

  it("grants one owner across concurrent store instances", async () => {
    const file = await makeStorePath();
    const stores = Array.from({ length: 8 }, () => new OrderIdempotencyStore(file));

    const reservations = await Promise.all(stores.map((store) => store.reserve(request)));

    expect(reservations.filter((entry) => entry.owner)).toHaveLength(1);
  });

  it("publishes only complete owner metadata and never grants two owners when one initializer is paused", async () => {
    const file = await makeStorePath();
    let releaseFirstLink!: () => void;
    const firstLinkPaused = new Promise<void>((resolve) => { releaseFirstLink = resolve; });
    let firstReachedLink!: () => void;
    const firstAtLink = new Promise<void>((resolve) => { firstReachedLink = resolve; });
    let pause = true;
    const slow = new OrderIdempotencyStore(file, {
      lockInitializationGraceMs: 0,
      fileSystem: {
        link: async (source, destination) => {
          if (pause) {
            pause = false;
            firstReachedLink();
            await firstLinkPaused;
          }
          await link(source, destination);
        },
      },
    });
    const competitor = new OrderIdempotencyStore(file, { lockInitializationGraceMs: 0 });

    const slowReservation = slow.reserve(request);
    await firstAtLink;
    const competitorReservation = await competitor.reserve(request);
    releaseFirstLink();
    const delayedReservation = await slowReservation;

    expect([competitorReservation, delayedReservation].filter((entry) => entry.owner)).toHaveLength(1);
    expect(competitorReservation.owner).toBe(true);
    expect(delayedReservation.owner).toBe(false);
    await expect(readFile(`${file}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps uncertain submissions non-retryable after restart", async () => {
    const file = await makeStorePath();
    const store = new OrderIdempotencyStore(file);
    await store.reserve(request);
    await store.recordUncertain(request, {
      message: "request timed out",
      transportCode: "UND_ERR_CONNECT_TIMEOUT",
      submissionUncertain: true,
    });

    const restarted = new OrderIdempotencyStore(file);
    const reservation = await restarted.reserve(request);

    expect(reservation.owner).toBe(false);
    expect(reservation.record).toMatchObject({
      state: "uncertain",
      error: { submissionUncertain: true, transportCode: "UND_ERR_CONNECT_TIMEOUT" },
    });
  });

  it("persists only order data and never credentials", async () => {
    const file = await makeStorePath();
    const store = new OrderIdempotencyStore(file);
    await store.reserve(request);
    const serialized = await readFile(file, "utf8");

    expect(serialized).not.toMatch(/password|cookie|token|credential/i);
  });

  it("recovers when a real process dies after creating an empty lock", async () => {
    const file = await makeStorePath();
    const lockPath = `${file}.lock`;
    const child = spawn(process.execPath, [
      "-e",
      "require('fs').openSync(process.argv[1], 'wx', 0o600); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      lockPath,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", () => resolve());
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const store = new OrderIdempotencyStore(file, { lockInitializationGraceMs: 25 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reservation = await store.reserve(request);

    expect(reservation.owner).toBe(true);
  });

  it("fsyncs the parent directory after rename", async () => {
    const file = await makeStorePath();
    const events: string[] = [];
    const store = new OrderIdempotencyStore(file, {
      fileSystem: {
        open: async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          if (target === path.dirname(file)) {
            const originalSync = handle.sync.bind(handle);
            handle.sync = async () => {
              events.push("parent-sync");
              return originalSync();
            };
          }
          return handle;
        },
        rename: async (source, destination) => {
          events.push("rename");
          await (await import("node:fs/promises")).rename(source, destination);
        },
      },
    });

    await store.reserve(request);

    expect(events).toEqual(["rename", "parent-sync"]);
  });

  it("removes temp files when temp fsync fails", async () => {
    const file = await makeStorePath();
    const store = new OrderIdempotencyStore(file, {
      fileSystem: {
        open: async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          if (target.endsWith(".tmp")) {
            handle.sync = async () => { throw new Error("injected temp fsync failure"); };
          }
          return handle;
        },
      },
    });

    await expect(store.reserve(request)).rejects.toThrow("injected temp fsync failure");
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes its lock when lock metadata fsync fails", async () => {
    const file = await makeStorePath();
    const lockPath = `${file}.lock`;
    const store = new OrderIdempotencyStore(file, {
      fileSystem: {
        open: async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          if (String(target).startsWith(`${lockPath}.`) && String(target).endsWith(".owner")) {
            handle.sync = async () => { throw new Error("injected lock fsync failure"); };
          }
          return handle;
        },
      },
    });

    await expect(store.reserve(request)).rejects.toThrow("injected lock fsync failure");
    expect((await readdir(path.dirname(file))).filter((name) => name.includes(".lock"))).toEqual([]);
  });

  it("cleans an unpublished owner file and preserves the write error when close also fails", async () => {
    const file = await makeStorePath();
    const store = new OrderIdempotencyStore(file, {
      fileSystem: {
        open: async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          if (String(target).includes(".lock.") && String(target).endsWith(".owner")) {
            handle.writeFile = async () => { throw new Error("primary owner write failure"); };
            handle.close = async () => { throw new Error("secondary owner close failure"); };
          }
          return handle;
        },
      },
    });

    await expect(store.reserve(request)).rejects.toThrow("primary owner write failure");
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".owner"))).toEqual([]);
  });

  it("cleans the published owner alias during release when the first unlink fails", async () => {
    const file = await makeStorePath();
    let failedPublishedOwnerCleanup = false;
    const store = new OrderIdempotencyStore(file, {
      fileSystem: {
        unlink: async (target) => {
          if (!failedPublishedOwnerCleanup && String(target).endsWith(".owner")) {
            failedPublishedOwnerCleanup = true;
            throw Object.assign(new Error("injected first owner unlink failure"), { code: "EIO" });
          }
          await unlink(target);
        },
      },
    });

    expect((await store.reserve(request)).owner).toBe(true);

    expect(failedPublishedOwnerCleanup).toBe(true);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".owner"))).toEqual([]);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".lock"))).toEqual([]);
  });

  it("cleans a temp file and preserves the write error when close also fails", async () => {
    const file = await makeStorePath();
    const store = new OrderIdempotencyStore(file, {
      fileSystem: {
        open: async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          if (String(target).endsWith(".tmp")) {
            handle.writeFile = async () => { throw new Error("primary temp write failure"); };
            handle.close = async () => { throw new Error("secondary temp close failure"); };
          }
          return handle;
        },
        unlink,
      },
    });

    await expect(store.reserve(request)).rejects.toThrow("primary temp write failure");
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("tightens existing store directory and data file permissions", async () => {
    const file = await makeStorePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ version: 1, records: {} })}\n`, { mode: 0o644 });
    await chmod(path.dirname(file), 0o755);
    await chmod(file, 0o644);

    await new OrderIdempotencyStore(file).reserve(request);

    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
