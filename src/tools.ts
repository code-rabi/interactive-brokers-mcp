import McpServer from "@modelcontextprotocol/sdk/server/mcp.js";
import IBClient from "./ib-client.js";
import IBGatewayManager from "./gateway-manager.js";
import { ToolHandlers, ToolHandlerContext } from "./tool-handlers.js";
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
  ) => server.tool(name, description, schema as never, handler as never);

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
    "Get current positions. Usage: `{ \"accountId\": \"U1234567\" }`.",
    GetPositionsZodShape,
    async (args) => await handlers.getPositions(args),
  );

  registerTool(
    "get_option_chain",
    "Get option expirations and strikes for an underlying symbol. Usage: `{ \"symbol\": \"AAPL\", \"exchange\": \"SMART\" }`.",
    GetOptionChainZodShape,
    async (args) => await handlers.getOptionChain(args),
  );

  registerTool(
    "resolve_option_conid",
    "Resolve a specific option contract conid from symbol, expiry, strike, and right. Usage: `{ \"symbol\": \"AAPL\", \"expiry\": \"JAN27\", \"strike\": 200, \"right\": \"C\" }`.",
    ResolveOptionConidZodShape,
    async (args) => await handlers.resolveOptionConid(args),
  );

  registerTool(
    "get_market_data",
    "Get real-time market data. Usage: `{ \"symbol\": \"AAPL\" }`.",
    GetMarketDataZodShape,
    async (args) => await handlers.getMarketData(args),
  );

  if (!userConfig?.IB_READ_ONLY_MODE) {
    registerTool(
      "place_order",
      "Place market, limit, or stop orders. Supports stocks by symbol and options via `conid` or `{ secType: \"OPT\", symbol, expiry, strike, right }`.",
      PlaceOrderZodShape,
      async (args) => await handlers.placeOrder(args),
    );
  }

  registerTool(
    "get_order_status",
    "Get order status. Usage: `{ \"orderId\": \"12345\" }`.",
    GetOrderStatusZodShape,
    async (args) => await handlers.getOrderStatus(args),
  );

  registerTool(
    "get_live_orders",
    "Get live orders. Usage: `{ \"accountId\": \"U1234567\" }` or `{}`.",
    GetLiveOrdersZodShape,
    async (args) => await handlers.getLiveOrders(args),
  );

  if (!userConfig?.IB_READ_ONLY_MODE) {
    registerTool(
      "confirm_order",
      "Confirm a pending order reply. Usage: `{ \"replyId\": \"...\", \"messageIds\": [\"...\"] }`.",
      ConfirmOrderZodShape,
      async (args) => await handlers.confirmOrder(args),
    );
  }

  registerTool(
    "get_alerts",
    "Get alerts for an account. Usage: `{ \"accountId\": \"U1234567\" }`.",
    GetAlertsZodShape,
    async (args) => await handlers.getAlerts(args),
  );

  if (!userConfig?.IB_READ_ONLY_MODE) {
    registerTool(
      "create_alert",
      "Create an account alert.",
      CreateAlertZodShape,
      async (args) => await handlers.createAlert(args),
    );

    registerTool(
      "activate_alert",
      "Activate an alert. Usage: `{ \"accountId\": \"U1234567\", \"alertId\": \"123\" }`.",
      ActivateAlertZodShape,
      async (args) => await handlers.activateAlert(args),
    );

    registerTool(
      "delete_alert",
      "Delete an alert. Usage: `{ \"accountId\": \"U1234567\", \"alertId\": \"123\" }`.",
      DeleteAlertZodShape,
      async (args) => await handlers.deleteAlert(args),
    );
  }

  registerTool(
    "get_flex_query",
    "Run a configured Flex Query. Usage: `{ \"queryId\": \"...\", \"queryName\": \"optional\", \"parseXml\": true }`.",
    GetFlexQueryZodShape,
    async (args) => await handlers.getFlexQuery(args),
  );

  registerTool(
    "list_flex_queries",
    "List remembered Flex Queries. Usage: `{ \"confirm\": true }`.",
    ListFlexQueriesZodShape,
    async (args) => await handlers.listFlexQueries(args),
  );

  if (!userConfig?.IB_READ_ONLY_MODE) {
    registerTool(
      "forget_flex_query",
      "Forget a remembered Flex Query. Usage: `{ \"queryId\": \"...\" }`.",
      ForgetFlexQueryZodShape,
      async (args) => await handlers.forgetFlexQuery(args),
    );
  }
}
