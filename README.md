# @mouryabalabhadra/ts-cloudflare-auth

Reusable ThoughtSpot OAuth + bearer authentication for Cloudflare Workers MCP servers.

Extracted from [thoughtspot/mcp-server](https://github.com/thoughtspot/mcp-server) so multiple MCP servers (e.g. `mcp-server`, `spotter-code`) can share the same auth flow.

## What it provides

- OAuth 2.0 authorize/callback/token/register flow against a ThoughtSpot instance (SAML-based)
- Bearer/token endpoints (`/bearer/*`, `/token/*`) for direct access-token-based auth
- A pluggable Hono app that mounts onto any Cloudflare Workers MCP server based on `agents/mcp` + `@modelcontextprotocol/sdk`
- Approval dialog + token-callback HTML pages (configurable branding)

## Install

```bash
npm install @mouryabalabhadra/ts-cloudflare-auth
# or via file: during development
npm install file:../ts-cloudflare-auth
```

Peer deps: `@cloudflare/workers-oauth-provider`, `agents`, `hono`.

## Usage

```ts
import { createOAuthHandler, PUBLIC_ROUTES } from "@mouryabalabhadra/ts-cloudflare-auth";

const handler = createOAuthHandler({
  serverInfo: {
    name: "My MCP Server",
    logo: "https://example.com/logo.png",
    description: "MCP Server for X",
  },
  mcpServerClass: MyMcpDurableObject,
  routes: { mcp: "/auth/mcp", sse: "/auth/sse" },
  hooks: {
    onAuthMetric: (name, status, ctx, req) => { /* optional */ },
    extendProps: (req, base) => ({ ...base, customField: "..." }),
  },
});

export default {
  fetch: handler.fetch,
};
```

## Static assets

The token callback page expects `oauth-callback.{html,css,js}` available via an `assetsFetcher`. Either ship the bundled assets in `./assets/` to your Worker's `[assets]` binding, or pass a custom fetcher.

## License

MIT
