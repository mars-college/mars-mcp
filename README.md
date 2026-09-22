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

`npm run dev` and `npm start` load `.env` automatically (node's
`--env-file-if-exists`); there is no `dotenv` dependency.

| Script | Does |
|---|---|
| `npm run dev` | Watch mode via tsx |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | `tsc --noEmit` — the only check gate; there is no test suite yet |

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
  -H 'Authorization: Bearer replace-me-dev-only' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

That responds as an SSE stream (`content-type: text/event-stream`), not plain
JSON — the payload is on a `data:` line, so piping it straight to `jq` will not
work.

## The tool

One tool so far, `mars_lookup`:

| Argument | Type | Meaning |
|---|---|---|
| `topic` | string, optional | Topic key — currently `about` or `season` |
| `list_topics` | boolean, optional | Return the available topics instead of a fact |

Called with no arguments it lists topics. An unknown topic returns an MCP error
result rather than an empty one.

`GET` and `DELETE` on `/mcp` return `405` with `Allow: POST` — stateless mode has
no server-initiated stream and no session to delete. They sit behind auth on
purpose, so that an unauthenticated `GET /mcp` returns the `401` +
`WWW-Authenticate` that clients use as a discovery entry point.

## Shape

| File | Role |
|---|---|
| `src/index.ts` | Express app, RFC 9728 metadata, bearer middleware, Streamable HTTP transport |
| `src/auth.ts` | Token verification. **The seam** — `createVerifier()` owns its own config, so replacing the stub does not touch `index.ts` |
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
> Anyone holding a string from `MARS_STUB_TOKENS` is fully authorized, and there
> is no rate limiting on `/mcp`.

### Known gap: `authorization_servers` points at this host

The protected-resource metadata advertises `AUTH_ISSUER_URL`, which currently
defaults to this server — and this server publishes no authorization-server
metadata. A client that follows RFC 9728 discovery will fetch
`/.well-known/oauth-authorization-server`, get a 404, and fall back to implicit
endpoints (`/authorize`, `/register`) that also 404, surfacing as an opaque OAuth
failure rather than "there is no authorization server here". Resolving this is
part of choosing an authorization server; omitting the field entirely (it is
OPTIONAL in RFC 9728) would fail more honestly in the meantime.

Note: SDK 1.30.0 negotiates MCP protocol `2025-11-25`. A newer spec revision
exists; the SDK does not implement it yet.

**No CORS headers are sent.** Native clients (Claude Desktop/Code) are fine;
browser-hosted MCP clients will fail preflight until CORS is added.

## Deploying to eden2

Runs under rootless Podman as the host user `mars`, bound to loopback, with Caddy
terminating TLS in front at `mcp.mars.college`.

```bash
loginctl enable-linger mars      # once per host — without it the unit dies at logout
podman build -t mars-mcp:latest .
install -D -m600 .env ~/mars-mcp.env
install -D -m644 mars-mcp.service ~/.config/systemd/user/mars-mcp.service
systemctl --user daemon-reload && systemctl --user enable --now mars-mcp
```

The box has no GitHub credentials and the repo is private, so source reaches
`/srv/mars-mcp` by `rsync`, not `git pull`.

**Two values must differ from the `.env.example` defaults in production:**

- `BIND_HOST=0.0.0.0` — inside a container the network namespace is the isolation
  boundary and the host's `--publish 127.0.0.1:4400:4400` is what limits exposure.
  Binding the container's own loopback makes the published port unreachable on
  some rootless network backends.
- `PUBLIC_URL=https://mcp.mars.college` — otherwise the server advertises a
  localhost metadata URL and every OAuth-capable client breaks.

The Caddy vhost is already in place in the host-level `/etc/caddy/Caddyfile`:

```
https://mcp.mars.college {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4400
}
```

That file is shared with dev.eden.art and bp.eden.art — **always back it up and run
`caddy validate` before reloading.** Note `encode` also matches
`text/event-stream`; harmless for the current one-shot responses, but worth
excluding if tools ever stream progress.

## Next

- [ ] Choose an authorization server and replace `StubTokenVerifier`, and resolve
      the `authorization_servers` gap above
- [ ] Decide what "authenticated Martian" means and where that roster lives
- [ ] Replace the hardcoded facts with real sources
- [ ] Add a test suite — there is currently no test runner
- [ ] Add CORS + rate limiting before any browser client or public rollout
- [x] ~~DNS A record + Caddy vhost~~ — done 2026-09-22, cert issued
