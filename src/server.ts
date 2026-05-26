import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IBClient } from "./ib-client.js";
import { IBGatewayManager } from "./gateway-manager.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";
import { Logger } from "./logger.js";

export const configSchema = z.object({
  // Authentication configuration
  IB_USERNAME: z.string().optional(),
  IB_PASSWORD_AUTH: z.string().optional(),
  IB_AUTH_TIMEOUT: z.number().optional(),
  IB_AUTH_WAIT_SECONDS: z.number().optional(),
  IB_AUTH_POLL_SECONDS: z.number().optional(),
  IB_HEADLESS_MODE: z.boolean().optional(),

  // Paper trading configuration
  IB_PAPER_TRADING: z.boolean().optional(),

  // Read-only mode configuration
  IB_READ_ONLY_MODE: z.boolean().optional(),
});

// Global gateway manager instance
let gatewayManager: IBGatewayManager | null = null;

// Initialize and start IB Gateway (fast startup for MCP plugin compatibility)
async function initializeGateway(ibClient?: IBClient) {
  if (!gatewayManager) {
    gatewayManager = new IBGatewayManager();

    try {
      Logger.info('⚡ Quick Gateway initialization for MCP plugin...');
      await gatewayManager.quickStartGateway();
      Logger.info('✅ Gateway initialization completed (background startup if needed)');

      // Update client port if provided
      if (ibClient) {
        ibClient.updatePort(gatewayManager.getCurrentPort());
      }
    } catch (error) {
      Logger.error('❌ Failed to initialize Gateway:', error);
      // Don't throw error during quick startup - tools will handle it
      Logger.warn('⚠️ Gateway initialization failed, tools will attempt connection when called');
    }
  }
  return gatewayManager;
}

export function createIBMCPServer({ config: userConfig }: { config: z.infer<typeof configSchema> }) {
  // Merge user config with environment config
  const mergedConfig = {
    ...config,
    ...userConfig
  };

  // Log the merged config for debugging (but redact sensitive info)
  const logConfig = { ...mergedConfig };
  if (logConfig.IB_PASSWORD_AUTH) logConfig.IB_PASSWORD_AUTH = '[REDACTED]';
  if (logConfig.IB_PASSWORD) logConfig.IB_PASSWORD = '[REDACTED]';
  Logger.info(`🔍 Final merged config: ${JSON.stringify(logConfig, null, 2)}`);

  // Create IB Client with default port initially - this will be updated once gateway starts
  const ibClient = new IBClient({
    host: mergedConfig.IB_GATEWAY_HOST,
    port: mergedConfig.IB_GATEWAY_PORT,
  });

  // Initialize gateway on first server creation and update client port
  initializeGateway(ibClient).catch(error => {
    Logger.error('Failed to initialize gateway:', error);
  });

  Logger.info('Gateway starting...');

  // Create MCP server
  const server = new McpServer({
    name: "interactive-brokers-mcp",
    version: "1.0.0"
  });

  // Register all tools with merged config
  registerTools(server, ibClient, gatewayManager || undefined, mergedConfig);

  Logger.info('Tools registered');

  return server;
}



