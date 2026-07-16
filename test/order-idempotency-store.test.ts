import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
