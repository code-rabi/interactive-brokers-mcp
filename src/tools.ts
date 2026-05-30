import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IBClient } from "./ib-client.js";
import { IBGatewayManager } from "./gateway-manager.js";
import { ToolHandlers, ToolHandlerContext } from "./tool-handlers.js";
import {
  AuthenticateZodShape,
  GetAccountInfoZodShape,
  GetPositionsZodShape,
  GetMarketDataZodShape,
  PlaceOrderZodShape,
  GetOrderStatusZodShape,
  GetLiveOrdersZodShape,
  ConfirmOrderZodShape,
  GetAlertsZodShape,
  CreateAlertZodShape,
  ActivateAlertZodShape,
  DeleteAlertZodShape,
  GetFlexQueryZodShape,
  ListFlexQueriesZodShape,
  ForgetFlexQueryZodShape
} from "./tool-definitions.js";

export function registerTools(
  server: McpServer,
  ibClient: IBClient,
  gatewayManager?: IBGatewayManager,
  userConfig?: any
) {
  // Create handler context
  const context: ToolHandlerContext = {
    ibClient,
    gatewayManager,
    config: userConfig,
  };

  // Create handlers instance
  const handlers = new ToolHandlers(context);

  server.tool(
    "authenticate",
    "Authenticate with Interactive Brokers. Usage: `{ \"confirm\": true }`.",
    AuthenticateZodShape,
    async (args) => await handlers.authenticate(args)
  );

  // Register get_account_info tool
  server.tool(
    "get_account_info",
    "Get account information and balances. Usage: `{ \"confirm\": true }`.",
    GetAccountInfoZodShape,
    async (args) => await handlers.getAccountInfo(args)
  );

  // Register get_positions tool
  server.tool(
    "get_positions",
    "Get current positions. Usage: `{}` or `{ \"accountId\": \"<id>\" }`.",
    GetPositionsZodShape,
    async (args) => await handlers.getPositions(args)
  );

  // Register get_market_data tool
  server.tool(
    "get_market_data",
    "Get real-time market data. Usage: `{ \"symbol\": \"AAPL\" }` or `{ \"symbol\": \"AAPL\", \"exchange\": \"NASDAQ\" }`.",
    GetMarketDataZodShape,
    async (args) => await handlers.getMarketData(args)
  );

  // Register place_order tool (skip if in read-only mode)
  if (!userConfig?.IB_READ_ONLY_MODE) {
    server.tool(
      "place_order",
      "Place a trading order. Examples:\n" +
      "- Market buy: `{ \"accountId\":\"abc\",\"symbol\":\"AAPL\",\"action\":\"BUY\",\"orderType\":\"MKT\",\"quantity\":1 }`\n" +
      "- Limit sell: `{ \"accountId\":\"abc\",\"symbol\":\"AAPL\",\"action\":\"SELL\",\"orderType\":\"LMT\",\"quantity\":1,\"price\":185.5 }`\n" +
      "- Stop sell: `{ \"accountId\":\"abc\",\"symbol\":\"AAPL\",\"action\":\"SELL\",\"orderType\":\"STP\",\"quantity\":1,\"stopPrice\":180 }`\n" +
      "- Suppress confirmations: `{ \"accountId\":\"abc\",\"symbol\":\"AAPL\",\"action\":\"BUY\",\"orderType\":\"MKT\",\"quantity\":1,\"suppressConfirmations\":true }`",
      PlaceOrderZodShape,
      async (args) => await handlers.placeOrder(args)
    );
  }

  // Register get_order_status tool
  server.tool(
    "get_order_status",
    "Get the status of a specific order. Usage: `{ \"orderId\": \"12345\" }`.",
    GetOrderStatusZodShape,
    async (args) => await handlers.getOrderStatus(args)
  );

  // Register get_live_orders tool
  server.tool(
    "get_live_orders",
    "Get all live/open orders for monitoring and validation. Usage: `{}` for all accounts or `{ \"accountId\": \"<id>\" }` for a specific account. " +
    "This is the recommended way to validate that market orders were executed successfully after placing them.",
    GetLiveOrdersZodShape,
    async (args) => await handlers.getLiveOrders(args)
  );

  // Register confirm_order tool (skip if in read-only mode)
  if (!userConfig?.IB_READ_ONLY_MODE) {
    server.tool(
      "confirm_order",
      "Manually confirm an order that requires confirmation. Usage: `{ \"replyId\": \"742a95a7-55f6-4d67-861b-2fd3e2b61e3c\", \"messageIds\": [\"o10151\", \"o10153\"] }`.",
      ConfirmOrderZodShape,
      async (args) => await handlers.confirmOrder(args)
    );
  }

  // Register get_alerts tool
  server.tool(
    "get_alerts",
    "Get all trading alerts for an account. Usage: `{ \"accountId\": \"<id>\" }`.",
    GetAlertsZodShape,
    async (args) => await handlers.getAlerts(args)
  );

  // Register create_alert tool (skip if in read-only mode)
  if (!userConfig?.IB_READ_ONLY_MODE) {
    server.tool(
      "create_alert",
      "Create a new trading alert. Usage: `{ \"accountId\": \"<id>\", \"alertRequest\": { \"alertName\": \"Price Alert\", \"conditions\": [{ \"conidex\": \"265598\", \"type\": \"price\", \"operator\": \">\", \"triggerMethod\": \"last\", \"value\": \"150\" }] } }`.",
      CreateAlertZodShape,
      async (args) => await handlers.createAlert(args)
    );
  }

  // Register activate_alert tool (skip if in read-only mode)
  if (!userConfig?.IB_READ_ONLY_MODE) {
    server.tool(
      "activate_alert",
      "Activate a previously created alert. Usage: `{ \"accountId\": \"<id>\", \"alertId\": \"<alertId>\" }`.",
      ActivateAlertZodShape,
      async (args) => await handlers.activateAlert(args)
    );
  }

  // Register delete_alert tool (skip if in read-only mode)
  if (!userConfig?.IB_READ_ONLY_MODE) {
    server.tool(
      "delete_alert",
      "Delete an alert. Usage: `{ \"accountId\": \"<id>\", \"alertId\": \"<alertId>\" }`.",
      DeleteAlertZodShape,
      async (args) => await handlers.deleteAlert(args)
    );
  }

  // Register Flex Query tools (only if token is configured)
  if (userConfig?.IB_FLEX_TOKEN) {
    server.tool(
      "get_flex_query",
      "Execute a Flex Query and retrieve statements/data. The query will be automatically remembered for future use. " +
      "Usage: `{ \"queryId\": \"123456\" }` or with a friendly name: `{ \"queryId\": \"123456\", \"queryName\": \"Monthly Trades\" }`. " +
      "Set `parseXml: false` to get raw XML instead of parsed JSON.",
      GetFlexQueryZodShape,
      async (args) => await handlers.getFlexQuery(args)
    );

    server.tool(
      "list_flex_queries",
      "List all previously used Flex Queries that have been automatically saved. Usage: `{ \"confirm\": true }`.",
      ListFlexQueriesZodShape,
      async (args) => await handlers.listFlexQueries(args)
    );

    server.tool(
      "forget_flex_query",
      "Remove a saved Flex Query from memory. Usage: `{ \"queryId\": \"123456\" }`.",
      ForgetFlexQueryZodShape,
      async (args) => await handlers.forgetFlexQuery(args)
    );
  }
}