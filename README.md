# Interactive Brokers MCP Server

<div align="center">
<img src="https://www.interactivebrokers.com/images/web/logos/ib-logo-text-black.svg" alt="Interactive Brokers" width="300">
</div>

> **DISCLAIMER**: This is an **unofficial**, community-developed MCP server
> and is **NOT** affiliated with or endorsed by Interactive Brokers. This
> software is in **Alpha state** and may not work perfectly.

A Model Context Protocol (MCP) server that provides integration with Interactive
Brokers' trading platform. This server allows AI assistants to interact with
your IB account to retrieve market data, check positions, and place trades.

<a href="https://glama.ai/mcp/servers/@code-rabi/interactive-brokers-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@code-rabi/interactive-brokers-mcp/badge" alt="Interactive Brokers Server MCP server" />
</a>

## 🔒 Security Notice
![Showcase of Interactive Brokers MCP](./IB-MCP.gif)


## Features

- **Interactive Brokers API Integration**: Full trading capabilities including account management, position tracking, real-time market data, and order management (market, limit, and stop orders)
- **Flex Query Support**: Execute Flex Queries to retrieve account statements, trade confirmations, and historical data. Queries are automatically remembered for easy reuse
- **Flexible Authentication**: Choose between browser-based OAuth authentication or headless mode with credentials for automated environments
- **Simple Setup**: Run directly with `npx` - no Docker or additional installations required. Includes pre-configured IB Gateway and Java runtime for all platforms

## Security Notice

**IMPORTANT WARNINGS:**

- **Financial Risk**: Trading involves substantial risk of loss. Always test
  with paper trading first.
- **Security**: This software handles sensitive financial data. Only run
  locally, never on public servers.
- **No Warranty**: This unofficial software comes with no warranties. Use at
  your own risk.
- **Not Financial Advice**: This tool is for automation only, not financial
  advice.

## Prerequisites

**No additional installations required for mainstream platforms.** This package includes:

- Pre-configured IB Gateway for all platforms (Linux, macOS, Windows)
- Java Runtime Environment (JRE) for macOS, Windows, and standard Linux builds
- Automatic first-run musl JRE download for Alpine-based containers (e.g. `node:lts-alpine`, supergateway)
- All necessary dependencies

You only need:

- Interactive Brokers account (paper or live trading)
- Node.js 18+ (for running the MCP server)

## Quick Start

Add this MCP server to your Cursor/Claude configuration:

```json
{
  "mcpServers": {
    "interactive-brokers": {
      "command": "npx",
      "args": ["-y", "interactive-brokers-mcp"]
    }
  }
}
```

When you first use the server, a web browser window will automatically open for
the Interactive Brokers OAuth authentication flow. Log in with your IB
credentials to authorize the connection.

## Headless Mode Configuration

For automated environments or when you prefer not to use a browser for
authentication, you can enable headless mode by configuring it in your MCP
server configuration:

```json
{
  "mcpServers": {
    "interactive-brokers": {
      "command": "npx",
      "args": ["-y", "interactive-brokers-mcp"],
      "env": {
        "IB_HEADLESS_MODE": "true",
        "IB_USERNAME": "your_ib_username",
        "IB_PASSWORD_AUTH": "your_ib_password"
      }
    }
  }
}

```

In headless mode, the server will automatically authenticate using your
credentials without opening a browser window. This is useful for:

- Automated trading systems
- Server environments without a display
- CI/CD pipelines
- Situations where browser interaction is not desired

**Important**: Even in headless mode, Interactive Brokers may still require
two-factor authentication (2FA). When 2FA is triggered, the headless
authentication will wait for you to complete the 2FA process through your
configured method (mobile app, SMS, etc.) before proceeding.

To enable paper trading, add `"IB_PAPER_TRADING": "true"` to your environment variables:

```json
{
  "mcpServers": {
    "interactive-brokers": {
      "command": "npx",
      "args": ["-y", "interactive-brokers-mcp"],
      "env": {
        "IB_HEADLESS_MODE": "true",
        "IB_USERNAME": "your_ib_username",
        "IB_PASSWORD_AUTH": "your_ib_password",
        "IB_PAPER_TRADING": "true"
      }
    }
  }
}
```

**Security Note**: Store credentials securely and never commit them to version
control. Consider using environment variable files or secure credential
management systems.

## Flex Query Configuration (Optional)

To use Flex Queries for retrieving account statements and historical data, you need to configure your Flex Web Service Token:

```json
{
  "mcpServers": {
    "interactive-brokers": {
      "command": "npx",
      "args": ["-y", "interactive-brokers-mcp"],
      "env": {
        "IB_FLEX_TOKEN": "your_flex_token_here"
      }
    }
  }
}
```

### How to Get Your Flex Token:

1. Log in to [Interactive Brokers Account Management](https://www.interactivebrokers.com/portal)
2. Go to **Settings** → **Account Settings**
3. Navigate to **Reporting** → **Flex Web Service**
4. Generate or retrieve your Flex Web Service Token

For detailed instructions on enabling Flex Web Service, see the [IB Flex Web Service Guide](https://www.ibkrguides.com/orgportal/performanceandstatements/flex-web-service.htm).

### Creating Flex Queries:

1. Go to **Reports** → **Flex Queries** in Account Management
2. Create or customize your query template
3. Click the info icon next to your query to find its Query ID

For a complete guide on creating and customizing Flex Queries, see the [IB Flex Queries Guide](https://www.ibkrguides.com/orgportal/performanceandstatements/flex.htm).

**Note**: When you execute a Flex Query for the first time, the MCP server automatically saves it with its name from the API. Future executions can reference the query by either its ID or its saved name.

### Flex Query Features:

- **Automatic Memory**: When you execute a Flex Query, it's automatically saved for future use
- **Easy Reuse**: Previously used queries are remembered - no need to copy query IDs repeatedly
- **Friendly Names**: Optionally provide a friendly name when first executing a query
- **Forget Queries**: Remove queries you no longer need with the `forget_flex_query` tool

## Configuration Variables

| Feature | Environment Variable | Command Line Argument |
|---------|---------------------|----------------------|
| Username | `IB_USERNAME` | `--ib-username` |
| Password | `IB_PASSWORD_AUTH` | `--ib-password-auth` |
| Headless Mode | `IB_HEADLESS_MODE` | `--ib-headless-mode` |
| Paper Trading | `IB_PAPER_TRADING` | `--ib-paper-trading` |
| Auth Timeout | `IB_AUTH_TIMEOUT` | `--ib-auth-timeout` |
| Force standalone bundled gateway | `IB_FORCE_STANDALONE_GATEWAY` | N/A |
| Flex Token | `IB_FLEX_TOKEN` | N/A |
| Read-only mode | `IB_READ_ONLY_MODE` | `--ib-read-only-mode` |

## Gateway Lifecycle

On startup, the MCP first probes reachable local Gateway endpoints on the configured port and common Client Portal Gateway ports. If a healthy existing Gateway is found, the MCP attaches to it and does not start another bundled Gateway.

When no suitable existing Gateway is reachable, the MCP starts the bundled Java Gateway as a durable detached process. Runtime coordination files are stored under `ib-gateway/.runtime/`:

- `gateway-session.json` records the MCP-managed Gateway pid, port, version, and log paths.
- `gateway-session.lock` prevents two MCP processes from starting duplicate managed Gateways at the same time.
- `gateway.stdout.log` and `gateway.stderr.log` receive the Gateway process output.

Normal MCP shutdown detaches from the Gateway and leaves it running so later MCP runs can reuse it. If `IB_FORCE_STANDALONE_GATEWAY=true` is set, the MCP skips unrelated external Gateway discovery, but it still reuses or coordinates through the durable MCP-managed session metadata and lock files.

To reset the managed Gateway session, stop the Gateway process recorded in `ib-gateway/.runtime/gateway-session.json`, then remove `ib-gateway/.runtime/gateway-session.json` and any stale `ib-gateway/.runtime/gateway-session.lock`. The MCP automatically removes stale metadata when the recorded pid no longer exists.

## Available MCP Tools

### Trading & Account Management

| Tool               | Description                               |
| ------------------ | ----------------------------------------- |
| `get_account_info` | Retrieve account information and balances |
| `get_positions`    | Get current positions and P&L             |
| `get_market_data`  | Real-time market data for symbols         |
| `place_order`      | Place market, limit, or stop orders (only if read-only mode is disabled) |
| `get_order_status` | Check order execution status              |
| `get_live_orders`  | Get all live/open orders for monitoring   |

### Flex Queries (Requires IB_FLEX_TOKEN)

| Tool                | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `get_flex_query`    | Execute a Flex Query and retrieve statements (auto-saves for reuse) |
| `list_flex_queries` | List all previously used Flex Queries                               |
| `forget_flex_query` | Remove a saved Flex Query from memory                               |

## Troubleshooting

**Authentication Problems:**

- Use the web interface that opens automatically
- Complete any required two-factor authentication
- Try paper trading mode if live trading fails

**Gateway Discovery Problems:**

- If another IB Gateway is already listening on a local port but should not be reused, set `IB_FORCE_STANDALONE_GATEWAY=true`
- Existing gateways are only reused when the MCP process can reach them over HTTPS; otherwise the bundled standalone gateway is started on an available port
- For MCP-managed Gateway startup issues, inspect `ib-gateway/.runtime/gateway.stdout.log`, `ib-gateway/.runtime/gateway.stderr.log`, and `ib-gateway/.runtime/gateway-session.json`
- To clear a stale managed startup lock, confirm no MCP process is currently starting Gateway, then remove `ib-gateway/.runtime/gateway-session.lock`

## Support

- **This Server**: Open an issue in this repository.

## License

MIT License - see LICENSE file for details.

## Thanks to our contributors

A big thank you to everyone who has contributed to making this project better.

<a href="https://github.com/code-rabi/interactive-brokers-mcp/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=code-rabi/interactive-brokers-mcp" alt="Contributors" />
</a>
