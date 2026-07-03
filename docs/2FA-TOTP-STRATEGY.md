# 🔐 TOTP 2FA Auto-Override Strategy

The Interactive Brokers MCP Server includes a headless authentication mechanism that can automate the login process even when Two-Factor Authentication (2FA) is enabled. 

Using the standard TOTP (Time-Based One-Time Password) strategy, the server can automatically generate and submit your security verification code during login.

---

## 🚀 How to Configure TOTP 2FA Strategy

To enable automatic 2FA override with TOTP, you need to provide your standard TOTP/Google Authenticator compatible Base32 secret key.

Configure the following environment variables in your MCP Server host configuration:

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
        "IB_TWO_FA_STRATEGY": "totp",
        "IB_TOTP_SECRET": "MZXW6YTBMRXW63DF" 
      }
    }
  }
}
```

### Configuration Parameters:
- **`IB_TWO_FA_STRATEGY`**: Must be set to `"totp"` (defaults to `"manual"`).
- **`IB_TOTP_SECRET`**: Your 2FA account's Base32 secret key. Spaces are ignored (e.g. `MZXW 6YTB MRXW 63DF` is perfectly fine).

---

## ⚠️ Risks and Security Warnings (Must Read)

Automating 2FA authentication bypasses a critical security layer. Before enabling this feature, you **must** understand and accept the following risks:

### 1. Storing Base32 Secret Keys Securely
Your `IB_TOTP_SECRET` is the raw cryptographic seed used to generate all future authentication tokens. 
- **High Risk of Account Compromise**: Anyone who has access to your configuration files can read this secret and generate valid 2FA tokens for your IBKR account.
- **Mitigation**: Never commit your secret keys to GitHub, public repositories, or share them in chat sessions. Store your MCP configuration files with strict filesystem permissions (e.g., `chmod 600`).

### 2. Automated Execution Risk
In "full auto mode", an AI assistant or automated trading script has full programmatic access to log in and make trades.
- **Financial Risk**: Errors in automated logic, looping code, or buggy prompt instructions could execute unintended trades, causing substantial financial loss.
- **Mitigation**: Thoroughly test all automation in **Paper Trading Mode** first. Set tight risk limits on your Interactive Brokers account.

### 3. Account Locking on Repeated Failures
Interactive Brokers enforces strict rate-limiting and security protections.
- **Account Lockout**: If the automated login script attempts to log in with an incorrect password, expired TOTP code, or mismatched credentials **10 consecutive times**, IBKR will permanently lock your account.
- **Unlocking Process**: Unlocking a locked account requires calling Interactive Brokers customer support by phone and completing identity verification.
- **Mitigation**: Ensure your credentials and secret are perfectly correct. If the server logs display consecutive auth failures, immediately disable the MCP server or headless mode to prevent lockouts.

### 4. Clock Synchronization
TOTP is highly time-sensitive. If your host system's clock drifts by more than a few seconds, the generated codes will be invalid and rejected by IBKR, risking account lockouts.
- **Mitigation**: Ensure your server/system clock is synchronized via NTP (Network Time Protocol).
