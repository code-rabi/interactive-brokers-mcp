import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { IBClient } from "../src/ib-client.js";
import { IBGatewayManager } from "../src/gateway-manager.js";

vi.mock("../src/ib-client.js");
vi.mock("../src/gateway-manager.js");

const WRITE_TOOLS = [
  "place_order",
  "confirm_order",
  "create_alert",
  "activate_alert",
  "delete_alert",
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
