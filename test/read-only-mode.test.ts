import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools.js";
import { IBClient } from "../src/ib-client.js";
import { IBGatewayManager } from "../src/gateway-manager.js";
import { OrderIdempotencyStore } from "../src/order-idempotency-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../src/ib-client.js");
vi.mock("../src/gateway-manager.js");

const WRITE_TOOLS = [
  "place_order",
  "confirm_order",
  "create_alert",
  "activate_alert",
  "delete_alert",
  "cancel_order",
];

describe("read-only safety defaults", () => {
  let mockMcpServer: McpServer;
  let mockIBClient: IBClient;
  let mockGatewayManager: IBGatewayManager;
  let registeredTools: string[];

  beforeEach(() => {
    registeredTools = [];
    mockMcpServer = {
      tool: vi.fn().mockImplementation((name) => {
        registeredTools.push(name);
        return mockMcpServer;
      }),
      registerTool: vi.fn().mockImplementation((name) => {
        registeredTools.push(name);
        return mockMcpServer;
      }),
    } as unknown as McpServer;
    mockIBClient = {} as IBClient;
    mockGatewayManager = {} as IBGatewayManager;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("defaults omitted IB_READ_ONLY_MODE to true", async () => {
    vi.stubEnv("IB_READ_ONLY_MODE", "");
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.IB_READ_ONLY_MODE).toBe(true);
  });

  it("does not register write tools when read-only mode is omitted", () => {
    registerTools(mockMcpServer, mockIBClient, mockGatewayManager);
    expect(registeredTools).toEqual(expect.arrayContaining([
      "get_positions", "get_market_data", "get_account_info", "get_live_orders",
    ]));
    for (const tool of WRITE_TOOLS) expect(registeredTools).not.toContain(tool);
  });

  it("refuses live write registration without an allowed account", () => {
    expect(() => registerTools(mockMcpServer, mockIBClient, mockGatewayManager, {
      IB_READ_ONLY_MODE: false,
    })).toThrow(/IB_ALLOWED_ACCOUNT_ID/);
  });

  it("registers write tools only with explicit false and an allowed account", () => {
    registerTools(mockMcpServer, mockIBClient, mockGatewayManager, {
      IB_READ_ONLY_MODE: false,
      IB_ALLOWED_ACCOUNT_ID: "U12345",
    });
    for (const tool of WRITE_TOOLS) expect(registeredTools).toContain(tool);
  });
});

describe("place_order MCP entrypoint validation", () => {
  it("publishes the complete object contract through tools/list", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    const ibClient = {} as IBClient;
    registerTools(server, ibClient, undefined, {
      IB_READ_ONLY_MODE: false,
      IB_ALLOWED_ACCOUNT_ID: "U12345",
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const placeOrder = tools.find((tool) => tool.name === "place_order");

      expect(placeOrder?.inputSchema.type).toBe("object");
      expect(Object.keys(placeOrder?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
        "clientOrderId",
        "accountId",
        "symbol",
        "conid",
        "action",
        "orderType",
        "quantity",
        "price",
        "exchange",
        "tif",
      ]));
      expect(placeOrder?.inputSchema.required).toEqual(expect.arrayContaining([
        "clientOrderId",
        "accountId",
        "action",
        "orderType",
        "quantity",
        "price",
      ]));
      expect(placeOrder?.inputSchema.additionalProperties).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["secType", "expiry", "right", "suppressConfirmations"])(
    "rejects forbidden field %s instead of stripping it",
    async (field) => {
      const server = new McpServer({ name: "test-server", version: "1.0.0" });
      const ibClient = {
        checkAuthenticationStatus: vi.fn().mockResolvedValue(true),
        placeOrder: vi.fn().mockResolvedValue({ orderId: "unsafe" }),
      } as unknown as IBClient;
      registerTools(server, ibClient, undefined, {
        IB_READ_ONLY_MODE: false,
        IB_ALLOWED_ACCOUNT_ID: "U12345",
      });

      const client = new Client({ name: "test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.callTool({
          name: "place_order",
          arguments: {
            clientOrderId: `forbidden-${field}`,
            accountId: "U12345",
            symbol: "AAPL",
            action: "BUY",
            orderType: "LMT",
            quantity: 1,
            price: 150,
            [field]: field === "suppressConfirmations" ? true : "forbidden",
          },
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/unrecognized|invalid/i);
        expect(ibClient.placeOrder).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

describe("cancel_order MCP entrypoint validation", () => {
  it("rejects unknown fields at the real callTool boundary without cancelling", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    const ibClient = {
      checkAuthenticationStatus: vi.fn().mockResolvedValue(true),
      cancelOrder: vi.fn().mockResolvedValue({ orderId: "123", status: "Cancelled" }),
    } as unknown as IBClient;
    registerTools(server, ibClient, undefined, {
      IB_READ_ONLY_MODE: false,
      IB_ALLOWED_ACCOUNT_ID: "U12345",
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const cancelOrder = tools.find((tool) => tool.name === "cancel_order");
      expect(cancelOrder?.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["accountId", "orderId"]),
        additionalProperties: false,
      });
      expect(Object.keys(cancelOrder?.inputSchema.properties ?? {})).toEqual(["accountId", "orderId"]);

      const result = await client.callTool({
        name: "cancel_order",
        arguments: {
          accountId: "U12345",
          orderId: "123",
          suppressConfirmations: true,
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/unrecognized|invalid/i);
      expect(ibClient.cancelOrder).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("confirm_order MCP provenance", () => {
  it("confirms only a reply persisted by this MCP and survives a server restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ib-mcp-calltool-confirm-"));
    const storePath = path.join(dir, "orders.json");
    const ibClient = {
      checkAuthenticationStatus: vi.fn().mockResolvedValue(true),
      prepareOrder: vi.fn().mockResolvedValue({ accountId: "U12345", order: { conid: 265598 } }),
      submitPreparedOrder: vi.fn().mockResolvedValue([{ id: "reply-calltool-1", message: ["warning"] }]),
      confirmOrder: vi.fn().mockImplementation(async (replyId: string) => (
        replyId === "reply-calltool-1"
          ? [{ id: "reply-calltool-2", message: ["warning 2"] }]
          : { orderId: "submitted-after-confirm", status: "Submitted" }
      )),
    } as unknown as IBClient;

    const callWithServer = async (calls: Array<{ name: string; arguments: Record<string, unknown> }>) => {
      const server = new McpServer({ name: "test-server", version: "1.0.0" });
      registerTools(server, ibClient, undefined, {
        IB_READ_ONLY_MODE: false,
        IB_ALLOWED_ACCOUNT_ID: "U12345",
        IB_ORDER_IDEMPOTENCY_STORE_PATH: storePath,
      });
      const client = new Client({ name: "test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        return await Promise.all(calls.map((call) => client.callTool(call)));
      } finally {
        await client.close();
        await server.close();
      }
    };

    try {
      await callWithServer([{
        name: "place_order",
        arguments: {
          clientOrderId: "calltool-confirm-chain",
          accountId: "U12345",
          symbol: "AAPL",
          action: "BUY",
          orderType: "LMT",
          quantity: 1,
          price: 150,
        },
      }]);
      const [unknown] = await callWithServer([
        { name: "confirm_order", arguments: { replyId: "unknown", messageIds: [] } },
      ]);
      const [confirmed] = await callWithServer([
        { name: "confirm_order", arguments: { replyId: "reply-calltool-1", messageIds: [] } },
      ]);
      const [secondStep] = await callWithServer([
        { name: "confirm_order", arguments: { replyId: "reply-calltool-2", messageIds: [] } },
      ]);

      expect(JSON.stringify(unknown.content)).toMatch(/not authorized/i);
      expect(JSON.stringify(confirmed.content)).toContain("reply-calltool-2");
      expect(JSON.stringify(secondStep.content)).toContain("submitted-after-confirm");

      const store = new OrderIdempotencyStore(storePath);
      const baseOrder = {
        symbol: "AAPL",
        action: "BUY" as const,
        orderType: "LMT" as const,
        quantity: 1,
        price: 150,
      };
      const foreign = { ...baseOrder, clientOrderId: "foreign", accountId: "U99999" };
      await store.reserve(foreign);
      await store.recordResponse(foreign, [{ id: "foreign-reply", message: ["warning"] }]);
      const [foreignResult] = await callWithServer([
        { name: "confirm_order", arguments: { replyId: "foreign-reply", messageIds: [] } },
      ]);
      expect(JSON.stringify(foreignResult.content)).toMatch(/not authorized/i);

      for (const clientOrderId of ["duplicate-a", "duplicate-b"]) {
        const order = { ...baseOrder, clientOrderId, accountId: "U12345" };
        await store.reserve(order);
        await store.recordResponse(order, [{ id: "duplicate-reply", message: ["warning"] }]);
      }
      const [duplicate] = await callWithServer([
        { name: "confirm_order", arguments: { replyId: "duplicate-reply", messageIds: [] } },
      ]);
      expect(JSON.stringify(duplicate.content)).toMatch(/ambiguous/i);

      const persistenceOrder = { ...baseOrder, clientOrderId: "persistence", accountId: "U12345" };
      await store.reserve(persistenceOrder);
      await store.recordResponse(persistenceOrder, [{ id: "persistence-reply", message: ["warning"] }]);
      const persistenceSpy = vi.spyOn(OrderIdempotencyStore.prototype, "recordConfirmationResponse")
        .mockRejectedValueOnce(new Error("injected persistence failure"));
      const [persistenceResult] = await callWithServer([
        { name: "confirm_order", arguments: { replyId: "persistence-reply", messageIds: [] } },
      ]);
      persistenceSpy.mockRestore();
      expect(JSON.parse((persistenceResult.content[0] as { text: string }).text)).toMatchObject({
        code: "SUBMISSION_UNCERTAIN",
        submissionUncertain: true,
        brokerResponse: { orderId: "submitted-after-confirm" },
      });
      expect(ibClient.confirmOrder).toHaveBeenCalledTimes(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
