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
- **Flexible Authentication**: Choose between browser-based OAuth authentication or headless mode with credentials for automated environments, including fully automated TOTP 2FA override. See [TOTP 2FA Strategy Document](docs/2FA-TOTP-STRATEGY.md) for detailed configuration and important risk warnings.
- **Simple Setup**: Run directly with `npx` - no Docker or additional installations required. The IB Gateway and a Java runtime are fetched on first run from official vendor sources and verified before use

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

> 📖 Read **[SECURITY.md](./SECURITY.md)** for the full security posture: how third‑party
> dependencies are downloaded and verified, network exposure and gateway hardening, credential
> handling, and how to report a vulnerability.

## Prerequisites

You only need:

- Interactive Brokers account (paper or live trading)
- Node.js 18+ (for running the MCP server)
- Network access on first run (to download the IB Gateway and Java runtime)

> **v2 breaking change.** Starting with `v2.0.0` this package no longer bundles the IB Client
> Portal Gateway or a Java runtime. They are downloaded on demand from official vendor sources,
> verified, and cached locally (see [Dependency Resolution](#dependency-resolution-v2)). The first
> run therefore requires network access and may take longer. If you need the previous fully-offline
> behavior, pin to `interactive-brokers-mcp@1`, or pre-install the dependencies and disable downloads
> (`IB_DOWNLOADS_DISABLED=true`).

## Dependency Resolution (v2)

On startup the server resolves two third-party dependencies — the IB Client Portal Gateway and a
Java 11 runtime — in this order:

1. **User-managed (preferred).** If you point the server at your own installs it uses them as-is:
   - `IB_GATEWAY_DIR` — directory containing `clientportal.gw`
   - `IB_JAVA_HOME` / `JAVA_HOME` — a Java 11+ home
   - a system `java` on `PATH` (auto-adopted only for major versions 11–17)
2. **Downloaded on demand.** Anything missing is fetched from an official, pinned source:
   - **Java** — [BellSoft Liberica JRE 11](https://bell-sw.com/) (glibc and musl/Alpine builds)
   - **IB Gateway** — the official Interactive Brokers HTTPS distribution
3. **Verified before use.** Every artifact is checked against a pinned `sha256` recorded in
   [`dependencies.manifest.json`](./dependencies.manifest.json). The IB Gateway is additionally
   verified against the live MD5 that IB's CDN exposes in the `ETag` header, and is only ever
   downloaded over HTTPS from the official IB host.
4. **Cached and reused.** Verified artifacts are extracted into a per-user cache outside the package
   directory (`~/.cache/interactive-brokers-mcp` on Linux/macOS, `%LOCALAPPDATA%` on Windows, or
   `IB_CACHE_DIR`) and reused on subsequent runs.

### Controlling downloads

| Behavior | Variable | Notes |
| --- | --- | --- |
| Disable all downloads | `IB_DOWNLOADS_DISABLED=true` | Fails with a clear error if a dependency is missing. Use with `IB_GATEWAY_DIR` / `IB_JAVA_HOME`. |
| Override the cache location | `IB_CACHE_DIR=/path` | Defaults to the platform cache directory. |
| User-managed gateway | `IB_GATEWAY_DIR=/path` | Directory containing `clientportal.gw`. |
| User-managed Java | `IB_JAVA_HOME=/path` | A Java 11+ home; always honored regardless of version. |
| Proceed past a gateway checksum change | `IB_GATEWAY_ALLOW_UNVERIFIED=true` | IB ships a rolling "latest" gateway zip; if it rotates before the pinned `sha256` is updated, this lets you proceed. The live CDN `ETag` integrity check still runs. |

Maintainers can regenerate the pinned manifest with `npm run manifest:update`.

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
authentication will wait up to 60 seconds for you to complete the 2FA process
through your configured method (mobile app, SMS, etc.) before returning an
`AUTHENTICATION_PENDING` response. Wait for approval to complete, then check
account info again.

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
| Auth Wait Seconds | `IB_AUTH_WAIT_SECONDS` | `--ib-auth-wait-seconds` |
| Auth Poll Seconds | `IB_AUTH_POLL_SECONDS` | `--ib-auth-poll-seconds` |
| Force standalone managed gateway | `IB_FORCE_STANDALONE_GATEWAY` | N/A |
| Flex Token | `IB_FLEX_TOKEN` | N/A |
| Read-only mode | `IB_READ_ONLY_MODE` | `--ib-read-only-mode` |
| 2FA Strategy | `IB_TWO_FA_STRATEGY` | N/A |
| TOTP Secret Key | `IB_TOTP_SECRET` | N/A |
| Login page selector overrides | `IB_SELECTOR_USERNAME`, `IB_SELECTOR_PASSWORD`, `IB_SELECTOR_LOGIN_SUBMIT` | N/A |
| TOTP form selector overrides | `IB_SELECTOR_TOTP_INPUT`, `IB_SELECTOR_TOTP_SUBMIT` | N/A |
| Disable on-demand downloads | `IB_DOWNLOADS_DISABLED` | N/A |
| Dependency cache directory | `IB_CACHE_DIR` | N/A |
| User-managed gateway directory | `IB_GATEWAY_DIR` | N/A |
| User-managed Java home | `IB_JAVA_HOME` / `JAVA_HOME` | N/A |
| Allow unverified gateway (checksum rotated) | `IB_GATEWAY_ALLOW_UNVERIFIED` | N/A |

See the [TOTP 2FA Strategy Document](docs/2FA-TOTP-STRATEGY.md) for details on the 2FA and selector-override variables,
and [Dependency Resolution](#dependency-resolution-v2) for the download/verification controls.

## Gateway Lifecycle

On startup, the MCP first probes reachable local Gateway endpoints on the configured port and common Client Portal Gateway ports. If a healthy existing Gateway is found, the MCP attaches to it and does not start another managed Gateway.

When no suitable existing Gateway is reachable, the MCP [resolves the Gateway and Java runtime](#dependency-resolution-v2) and starts the Java Gateway as a durable detached process. Runtime coordination files are stored under the per-user cache run directory (`<cache>/run/`, where `<cache>` is `IB_CACHE_DIR` or the platform default):

- `gateway-session.json` records the MCP-managed Gateway pid, port, version, and log paths.
- `gateway-session.lock` prevents two MCP processes from starting duplicate managed Gateways at the same time.
- `gateway.stdout.log` and `gateway.stderr.log` receive the Gateway process output.

Normal MCP shutdown detaches from the Gateway and leaves it running so later MCP runs can reuse it. If `IB_FORCE_STANDALONE_GATEWAY=true` is set, the MCP skips unrelated external Gateway discovery, but it still reuses or coordinates through the durable MCP-managed session metadata and lock files.

To reset the managed Gateway session, stop the Gateway process recorded in `<cache>/run/gateway-session.json`, then remove that file and any stale `<cache>/run/gateway-session.lock`. The MCP automatically removes stale metadata when the recorded pid no longer exists.

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
- Existing gateways are only reused when the MCP process can reach them over HTTPS; otherwise a managed standalone gateway is started on an available port
- For MCP-managed Gateway startup issues, inspect `<cache>/run/gateway.stdout.log`, `<cache>/run/gateway.stderr.log`, and `<cache>/run/gateway-session.json` (where `<cache>` is `IB_CACHE_DIR` or the platform default cache directory)
- To clear a stale managed startup lock, confirm no MCP process is currently starting Gateway, then remove `<cache>/run/gateway-session.lock`
- If a download fails behind a restrictive network, either allow access to the BellSoft and Interactive Brokers download hosts, or pre-install the dependencies and set `IB_GATEWAY_DIR` / `IB_JAVA_HOME` with `IB_DOWNLOADS_DISABLED=true`

## Support

- **This Server**: Open an issue in this repository.

## License

MIT License - see LICENSE file for details.

## Thanks to our contributors

A big thank you to everyone who has contributed to making this project better.

<a href="https://github.com/code-rabi/interactive-brokers-mcp/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=code-rabi/interactive-brokers-mcp" alt="Contributors" />
</a>
