# mars-mcp

MCP server for Mars College. Authenticated Martians attach it to their agents to
get Mars info.

**Live at https://mcp.mars.college** (Let's Encrypt TLS via Caddy on eden2).

Independent of Eden — it happens to run on the same Hetzner box (`eden2`) to reuse
idle compute, under its own `mars` service account with rootless Podman, with no
access to the eden3 stack.

**Status: scaffold.** The transport and auth path work end to end. The knowledge
in it is two hardcoded facts, and token validation is a static allowlist. Both are
placeholders with clean seams.

## Quick start

```bash
npm install
cp .env.example .env     # then edit MARS_STUB_TOKENS
npm run dev
```

Verify:

```bash
curl -s localhost:4400/healthz
curl -s localhost:4400/.well-known/oauth-protected-resource | jq
```

An unauthenticated call returns `401` with a `WWW-Authenticate` header pointing at
the metadata document. With a token from `MARS_STUB_TOKENS`:

```bash
curl -s -X POST localhost:4400/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer dev-token-change-me' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Shape

| File | Role |
|---|---|
| `src/index.ts` | Express app, RFC 9728 metadata, bearer middleware, Streamable HTTP transport |
| `src/auth.ts` | Token verification. **The seam** — replace the stub here, nothing else changes |
| `src/tools.ts` | Tool registration. Real Mars data sources get added here |

**Transport** is Streamable HTTP in stateless mode — a fresh server and transport
per request, nothing pinned to one process, so this can move or scale out without
a sticky-session story.

**Auth** follows the MCP authorization split: this process is an OAuth 2.1
*resource server* that only validates tokens; a separate *authorization server*
will handle Martian login, consent and issuance. It is not built yet, so
`StubTokenVerifier` checks a static allowlist and mints a rolling expiry. The
protected-resource metadata is served by hand rather than through the SDK's
`mcpAuthMetadataRouter`, because that helper wants real authorization-server
metadata we do not have yet.

> **Do not put this in front of real Martians until the stub is replaced.**
> Anyone holding a string from `MARS_STUB_TOKENS` is fully authorized.

Note: SDK 1.30.0 negotiates MCP protocol `2025-11-25`. A newer spec revision
exists; the SDK does not implement it yet.

## Deploying to eden2

Runs as `mars` (uid 1001) under rootless Podman, bound to loopback, with Caddy
terminating TLS in front at `mcp.mars.college`.

```bash
podman build -t mars-mcp:latest .
install -D -m600 .env ~/mars-mcp.env
install -D -m644 mars-mcp.service ~/.config/systemd/user/mars-mcp.service
systemctl --user daemon-reload && systemctl --user enable --now mars-mcp
```

The Caddy vhost is already in place in the host-level `/etc/caddy/Caddyfile`:

```
https://mcp.mars.college {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4400
}
```

That file is shared with dev.eden.art and bp.eden.art — **always back it up and run
`caddy validate` before reloading.**

## Next

- [ ] Choose an authorization server and replace `StubTokenVerifier`
- [ ] Decide what "authenticated Martian" means and where that roster lives
- [ ] Replace the hardcoded facts with real sources
- [x] ~~DNS A record + Caddy vhost~~ — done 2026-09-22, cert issued
