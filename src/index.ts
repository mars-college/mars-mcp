import express, { type ErrorRequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { createVerifier } from './auth.js';
import { registerMarsTools } from './tools.js';

/** Single source of truth — `/healthz` and the MCP handshake must not drift apart. */
const VERSION = '0.1.0';
const SERVICE = 'mars-mcp';

/**
 * `??` would accept an empty string, and an empty BIND_HOST makes Node listen on
 * every interface while an empty PORT binds a random ephemeral one. Both are
 * plausible typos in an env file, and both silently defeat the loopback-only
 * posture the deployment relies on, so treat empty as absent.
 */
function env(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

const BIND_HOST = env('BIND_HOST', '127.0.0.1');
const PORT_RAW = env('PORT', '4400');
// Decimal digits only: Number() would happily read "0x10" as 16 and "4.49e3" as
// 4490, which is precisely the env-file typo this check exists to catch.
// No leading zeros either: "08" is a typo for 8 or 80 far more often than it is
// a deliberate request for port 8.
if (!/^[1-9]\d*$/.test(PORT_RAW)) {
  throw new Error(`PORT must be decimal digits without a leading zero, got "${PORT_RAW}"`);
}
const PORT = Number(PORT_RAW);
if (PORT < 1 || PORT > 65535) {
  throw new Error(`PORT must be 1-65535, got "${PORT_RAW}"`);
}

const PUBLIC_URL = env('PUBLIC_URL', `http://localhost:${PORT}`);
const AUTH_ISSUER_URL = env('AUTH_ISSUER_URL', PUBLIC_URL);
const SCOPES = ['mars.read'];

/**
 * The canonical resource identifier for an MCP server is its endpoint URL, not the
 * bare origin. RFC 9728 path insertion means a client derives the metadata URL from
 * it, and then expects the returned document's `resource` to match what it asked
 * for — so both must agree on `<origin>/mcp`.
 */
const RESOURCE_ID = new URL('/mcp', PUBLIC_URL).toString();
const resourceMetadataUrl = new URL(
  '/.well-known/oauth-protected-resource/mcp',
  PUBLIC_URL,
).toString();

const verifier = createVerifier(RESOURCE_ID);

/**
 * A fresh server + transport per request (stateless mode). Nothing is pinned to
 * one process, so this can sit behind a proxy or be scaled out later without a
 * sticky-session story.
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVICE, version: VERSION },
    { capabilities: { tools: {} } },
  );
  registerMarsTools(server);
  return server;
}

const app = express();
app.disable('x-powered-by');

/**
 * RFC 9728 protected-resource metadata. Clients fetch this (pointed here by the
 * WWW-Authenticate header on a 401) to discover which authorization server to
 * get a token from. Served by hand rather than via the SDK's
 * `mcpAuthMetadataRouter`, because that helper wants real authorization-server
 * metadata and we do not have an authorization server yet.
 *
 * Served at both the bare path and the path-inserted form: clients are told to
 * probe `/.well-known/oauth-protected-resource/mcp` first for a resource whose
 * canonical URL is `<origin>/mcp`, and only some fall back to the root.
 */
const protectedResourceMetadata = {
  resource: RESOURCE_ID,
  authorization_servers: [AUTH_ISSUER_URL],
  scopes_supported: SCOPES,
  bearer_methods_supported: ['header'],
  resource_name: 'Mars College MCP',
};

for (const path of [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]) {
  app.get(path, (_req, res) => {
    res.json(protectedResourceMetadata);
  });
}

// Unauthenticated: lets the box and uptime checks verify the process is alive.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: SERVICE, version: VERSION });
});

const auth = requireBearerAuth({
  verifier,
  requiredScopes: SCOPES,
  resourceMetadataUrl,
});

// Body parsing is scoped to /mcp rather than global, so an unauthenticated caller
// cannot make the process parse a megabyte of JSON on the health or metadata paths.
const parseJson = express.json({ limit: '1mb' });

app.post('/mcp', auth, parseJson, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  // Without this the SDK swallows transport-level failures (bad Accept header,
  // unsupported content type, "no connection established for request id") and a
  // failed request produces no server-side log line at all.
  //
  // Only ONE hook: Protocol.connect() chains rather than replaces this handler, so
  // also setting `server.server.onerror` logged every error twice.
  transport.onerror = (err) => console.error('[mars-mcp] transport error:', err);

  res.on('close', () => {
    // `void` discards the promise but does not catch it; an onclose hook that
    // throws would otherwise become an unhandled rejection and kill the process.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mars-mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless mode has no server-initiated stream and no session to delete. These sit
// behind `auth` on purpose: an unauthenticated GET /mcp then returns 401 with
// WWW-Authenticate, which is the discovery entry point many clients use.
const methodNotAllowed: express.RequestHandler = (_req, res) => {
  // RFC 9110 requires Allow on a 405.
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: server runs stateless' },
    id: null,
  });
};
app.get('/mcp', auth, methodNotAllowed);
app.delete('/mcp', auth, methodNotAllowed);

/**
 * Express's default handler renders `err.stack` into the response whenever
 * NODE_ENV !== 'production'. Body-parser rejects malformed or oversized JSON
 * *before* auth runs, so without this an unauthenticated caller could read the
 * container's filesystem layout, dependency list and Node version.
 */
const jsonRpcErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  const status =
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;
  const clientFault = status >= 400 && status < 500;
  const type = (err as { type?: unknown }).type;

  // -32700 is specifically "Parse error"; anything else client-side is -32600.
  const [code, message] =
    !clientFault
      ? [-32603, 'Internal server error']
      : type === 'entity.parse.failed'
        ? [-32700, 'Parse error']
        : [-32600, 'Invalid Request'];

  if (clientFault) {
    // One line, no stack: enough to spot a client hammering the endpoint, without
    // handing an unrated-limited path a log-amplification lever.
    console.warn(`[${SERVICE}] rejected request: ${status} ${String(type ?? 'unknown')}`);
  } else {
    console.error(`[${SERVICE}] unhandled error:`, err);
  }

  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
};
// Unmatched routes never reach the error handler, so they returned Express HTML.
app.use((_req, res) => {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Not found' },
    id: null,
  });
});

app.use(jsonRpcErrors);

const httpServer = app.listen(PORT, BIND_HOST, () => {
  console.log(`[${SERVICE}] listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[${SERVICE}] public URL   ${PUBLIC_URL}`);
});

httpServer.on('error', (err) => {
  console.error(`[${SERVICE}] listen failed:`, err);
  process.exit(1);
});

/**
 * Without an explicit handler, `podman stop` waits out its full timeout on every
 * restart and then SIGKILLs, severing in-flight responses mid-stream. The unit also
 * passes --init so node is not PID 1 (where a default-disposition signal would be
 * dropped outright); this handler is what actually drains, belt and braces.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${SERVICE}] ${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    // Don't let a hung keep-alive connection hold the process open forever.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
