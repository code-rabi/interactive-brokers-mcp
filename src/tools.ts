import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IBClient } from "./ib-client.js";
import { IBGatewayManager } from "./gateway-manager.js";
import { ToolHandlers, type ToolHandlerContext } from "./tool-handlers.js";
import { OrderPolicy } from "./order-policy.js";
import {
  ActivateAlertZodShape,
  AuthenticateZodShape,
  ConfirmOrderZodShape,
  CreateAlertZodShape,
  DeleteAlertZodShape,
  ForgetFlexQueryZodShape,
  GetAccountInfoZodShape,
  GetAlertsZodShape,
  GetFlexQueryZodShape,
  GetLiveOrdersZodShape,
  GetMarketDataZodShape,
  GetOptionChainZodShape,
  GetOrderStatusZodShape,
  GetPositionsZodShape,
  ListFlexQueriesZodShape,
  PlaceOrderZodShape,
  ResolveOptionConidZodShape,
} from "./tool-definitions.js";

export function registerTools(
  server: McpServer,
  ibClient: IBClient,
  gatewayManager?: IBGatewayManager,
  userConfig?: any,
) {
  const orderPolicy = new OrderPolicy(userConfig ?? {});
  if (!orderPolicy.readOnly) orderPolicy.assertWriteEnabled();
  const writeEnabled = !orderPolicy.readOnly;

  const context: ToolHandlerContext = {
    ibClient,
    gatewayManager,
    config: userConfig ?? {},
  };

  const handlers = new ToolHandlers(context);

  const registerTool = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: any) => Promise<any>,
  ) => {
    server.tool(name, description, schema as never, handler as never);
  };

  registerTool(
    "authenticate",
    "Authenticate with Interactive Brokers. Usage: `{ \"confirm\": true }`.",
    AuthenticateZodShape,
    async (args) => await handlers.authenticate(args),
  );

  registerTool(
    "get_account_info",
    "Get account information and balances. Usage: `{ \"confirm\": true }`.",
    GetAccountInfoZodShape,
    async (args) => await handlers.getAccountInfo(args),
  );

  registerTool(
    "get_positions",
    "Get current positions. Usage: `{}` or `{ \"accountId\": \"<id>\" }`.",
    GetPositionsZodShape,
    async (args) => await handlers.getPositions(args),
  );

  registerTool(
    "get_option_chain",
    "Get option expirations and strikes for an underlying symbol. Usage: `{ \"symbol\": \"AAPL\" }` or `{ \"symbol\": \"AAPL\", \"exchange\": \"SMART\" }`.",
    GetOptionChainZodShape,
    async (args) => await handlers.getOptionChain(args),
  );

  registerTool(
    "resolve_option_conid",
    "Resolve a specific option contract conid. Usage: `{ \"symbol\": \"AAPL\", \"expiry\": \"JAN27\", \"strike\": 200, \"right\": \"C\" }` or add `{ \"exchange\": \"SMART\" }`.",
    ResolveOptionConidZodShape,
    async (args) => await handlers.resolveOptionConid(args),
  );

  registerTool(
    "get_market_data",
    "Get real-time market data. Usage: `{ \"symbol\": \"AAPL\" }` or `{ \"symbol\": \"AAPL\", \"exchange\": \"NASDAQ\" }`.",
    GetMarketDataZodShape,
    async (args) => await handlers.getMarketData(args),
  );

  if (writeEnabled) {
    registerTool(
      "place_order",
      "Place a limit stock order. Usage: `{ \"clientOrderId\":\"unique-id\",\"accountId\":\"abc\",\"symbol\":\"AAPL\",\"action\":\"BUY\",\"orderType\":\"LMT\",\"quantity\":1,\"price\":185.5 }`.",
      PlaceOrderZodShape,
      async (args) => await handlers.placeOrder(args),
    );
  }

  registerTool(
    "get_order_status",
    "Get the status of a specific order. Usage: `{ \"orderId\": \"12345\" }`.",
    GetOrderStatusZodShape,
    async (args) => await handlers.getOrderStatus(args),
  );

  registerTool(
    "get_live_orders",
    "Get all live/open orders for monitoring and validation. Usage: `{}` for all accounts or `{ \"accountId\": \"<id>\" }` for a specific account. " +
      "This is the recommended way to validate that market orders were executed successfully after placing them.",
    GetLiveOrdersZodShape,
    async (args) => await handlers.getLiveOrders(args),
  );

  if (writeEnabled) {
    registerTool(
      "confirm_order",
      "Manually confirm an order that requires confirmation. Usage: `{ \"replyId\": \"742a95a7-55f6-4d67-861b-2fd3e2b61e3c\", \"messageIds\": [\"o10151\", \"o10153\"] }`.",
      ConfirmOrderZodShape,
      async (args) => await handlers.confirmOrder(args),
    );
  }

  registerTool(
    "get_alerts",
    "Get all trading alerts for an account. Usage: `{ \"accountId\": \"<id>\" }`.",
    GetAlertsZodShape,
    async (args) => await handlers.getAlerts(args),
  );

  if (writeEnabled) {
    registerTool(
      "create_alert",
      "Create a new trading alert. Usage: `{ \"accountId\": \"<id>\", \"alertRequest\": { \"alertName\": \"Price Alert\", \"conditions\": [{ \"conidex\": \"265598\", \"type\": \"price\", \"operator\": \">\", \"triggerMethod\": \"last\", \"value\": \"150\" }] } }`.",
      CreateAlertZodShape,
      async (args) => await handlers.createAlert(args),
    );
  }

  if (writeEnabled) {
    registerTool(
      "activate_alert",
      "Activate a previously created alert. Usage: `{ \"accountId\": \"<id>\", \"alertId\": \"<alertId>\" }`.",
      ActivateAlertZodShape,
      async (args) => await handlers.activateAlert(args),
    );
  }

  if (writeEnabled) {
    registerTool(
      "delete_alert",
      "Delete an alert. Usage: `{ \"accountId\": \"<id>\", \"alertId\": \"<alertId>\" }`.",
      DeleteAlertZodShape,
      async (args) => await handlers.deleteAlert(args),
    );
  }

  if (userConfig?.IB_FLEX_TOKEN) {
    registerTool(
      "get_flex_query",
      "Execute a Flex Query and retrieve statements/data. The query will be automatically remembered for future use. " +
        "Usage: `{ \"queryId\": \"123456\" }` or with a friendly name: `{ \"queryId\": \"123456\", \"queryName\": \"Monthly Trades\" }`. " +
        "Set `parseXml: false` to get raw XML instead of parsed JSON.",
      GetFlexQueryZodShape,
      async (args) => await handlers.getFlexQuery(args),
    );

    registerTool(
      "list_flex_queries",
      "List all previously used Flex Queries that have been automatically saved. Usage: `{ \"confirm\": true }`.",
      ListFlexQueriesZodShape,
      async (args) => await handlers.listFlexQueries(args),
    );

    registerTool(
      "forget_flex_query",
      "Remove a saved Flex Query from memory. Usage: `{ \"queryId\": \"123456\" }`.",
      ForgetFlexQueryZodShape,
      async (args) => await handlers.forgetFlexQuery(args),
    );
  }
}
