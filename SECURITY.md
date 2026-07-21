# Security Policy

This document describes the security posture of `interactive-brokers-mcp` and how to report
issues. This is unofficial software that handles sensitive financial data and can place real
trades — please read this alongside the warnings in the [README](./README.md).

## Reporting a vulnerability

Please report security issues **privately**, not in public issues:

- Preferred: open a private advisory via GitHub Security Advisories on the repository
  (**Security → Report a vulnerability**).
- Alternatively, contact the maintainer through the repository's
  [issue tracker](https://github.com/code-rabi/interactive-brokers-mcp/issues) to arrange private
  disclosure (do not include exploit details in the public issue).

Please include the version, your platform, and steps to reproduce. We aim to acknowledge reports
promptly and will coordinate a fix and disclosure timeline with you.

## Supply chain: no bundled third‑party binaries (v2)

Starting with `v2.0.0`, this package **does not bundle or redistribute** the Interactive Brokers
Client Portal Gateway or a Java runtime. Shipping opaque third‑party binaries created an
unreviewable trust burden. Instead, those dependencies are resolved on demand and verified before
use ([details](./README.md#dependency-resolution-v2)):

- **Pinned sources.** Exact download URLs and checksums live in
  [`dependencies.manifest.json`](./dependencies.manifest.json), which is committed and reviewable.
- **Java** is [BellSoft Liberica JRE 11](https://bell-sw.com/) downloaded from immutable release
  assets and verified against a pinned `sha256` (pinned against BellSoft's published `sha1`).
- **IB Gateway** is downloaded **only over HTTPS from the official Interactive Brokers host**
  (`download2.interactivebrokers.com`). IB publishes no checksum file, so the bytes are verified
  two ways:
  1. against the **live MD5** that IB's CDN exposes in the `ETag` header at download time, and
  2. against a **pinned `sha256`** in the manifest.
- **Verified, then cached.** Artifacts are extracted into a per‑user cache outside the package
  directory and reused; a corrupt or mismatched download is rejected before it is ever executed.

### Checksum rotation and the unverified escape hatch

IB serves a rolling "latest" gateway zip with no stable version. If IB rotates that file before the
pinned `sha256` is updated, startup fails with a clear error. Setting
`IB_GATEWAY_ALLOW_UNVERIFIED=true` lets you proceed past the **pinned `sha256`** check only — the
HTTPS host pin and the live CDN `ETag` integrity check still run, so the artifact is never accepted
without an integrity check against IB itself. Prefer updating the manifest
(`npm run manifest:update`) over leaving this enabled.

### Disabling downloads / air‑gapped use

Set `IB_DOWNLOADS_DISABLED=true` to forbid all network downloads. In that mode you must provide the
dependencies yourself via `IB_GATEWAY_DIR` and `IB_JAVA_HOME` (or `JAVA_HOME`); otherwise startup
fails with an explicit error rather than reaching out to the network. Users who require the previous
fully‑offline, fully‑bundled behavior can pin to `interactive-brokers-mcp@1`.

## Network exposure

This tool is designed to run **locally**, never on a public host.

- **MCP server (default stdio mode):** communicates over stdio and opens **no network listener**.
- **MCP server (HTTP/SSE mode, `MCP_HTTP_SERVER=true`):** binds to **loopback `127.0.0.1`** by
  default and sets `cors({ origin: false })`, rejecting cross‑origin browser requests. Only override
  the bind host (`HOST`/`MCP_HOST`) if you understand the exposure.
- **IB Client Portal Gateway:** a local Java process that listens on port `5000` over TLS (a
  self‑signed certificate for `localhost`). It is started detached and reused across runs.

### Hardening the gateway's allowed clients

The downloaded gateway runs with **Interactive Brokers' own default configuration** — we do not
modify it. IB's default `ips.allow` permits its standard ranges (e.g. `192.*`, `131.216.*`) in
addition to loopback, so on a multi‑homed or LAN‑exposed host other machines in those ranges could
reach the gateway port. To restrict the gateway to loopback only, run it on a host without untrusted
LAN exposure, or point `IB_GATEWAY_DIR` at a user‑managed gateway whose `clientportal.gw/root/conf.yaml`
narrows `ips.allow`:

```yaml
ips:
  allow:
    - 127.0.0.1
    - ::1
```

A user‑managed gateway supplied via `IB_GATEWAY_DIR` is always used **as‑is** and is never modified
by this package.

## Credentials and secrets

- Credentials (`IB_USERNAME`, `IB_PASSWORD`, `IB_PASSWORD_AUTH`, `IB_FLEX_TOKEN`) are read from
  environment variables / MCP config and are used only to authenticate to Interactive Brokers.
- Do not commit credentials. Prefer your MCP client's secret handling or environment files that are
  excluded from version control.
- Always validate automated behavior with **paper trading** (`IB_PAPER_TRADING=true`) before using a
  live account, and consider read‑only mode (`IB_READ_ONLY_MODE=true`) to disable order placement.

## Supported versions

Security fixes target the latest `2.x` release. The `1.x` line is maintained only for users who
require the fully‑offline bundled model.
