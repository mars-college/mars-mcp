import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { parseStubTokens, StubTokenVerifier } from './auth.js';
import { registerMarsTools } from './tools.js';

const PORT = Number(process.env.PORT ?? 4400);
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const AUTH_ISSUER_URL = process.env.AUTH_ISSUER_URL ?? PUBLIC_URL;
const SCOPES = ['mars.read'];

const verifier = new StubTokenVerifier(
  parseStubTokens(process.env.MARS_STUB_TOKENS),
  PUBLIC_URL,
);

if (verifier.size === 0) {
  console.warn(
    '[mars-mcp] MARS_STUB_TOKENS is empty — every request will be rejected. ' +
      'Set it in .env (see .env.example).',
  );
}

/**
 * A fresh server + transport per request (stateless mode). Nothing is pinned to
 * one process, so this can sit behind a proxy or be scaled out later without a
 * sticky-session story.
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'mars-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerMarsTools(server);
  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const resourceMetadataUrl = new URL(
  '/.well-known/oauth-protected-resource',
  PUBLIC_URL,
).toString();

/**
 * RFC 9728 protected-resource metadata. Clients fetch this (pointed here by the
 * WWW-Authenticate header on a 401) to discover which authorization server to
 * get a token from. Served by hand rather than via the SDK's
 * `mcpAuthMetadataRouter`, because that helper wants real authorization-server
 * metadata and we do not have an authorization server yet.
 */
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: PUBLIC_URL,
    authorization_servers: [AUTH_ISSUER_URL],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Mars College MCP',
  });
});

// Unauthenticated: lets the box and uptime checks verify the process is alive.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'mars-mcp', version: '0.1.0' });
});

const auth = requireBearerAuth({
  verifier,
  requiredScopes: SCOPES,
  resourceMetadataUrl,
});

app.post('/mcp', auth, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
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

// Stateless mode has no server-initiated stream and no session to delete.
for (const method of ['get', 'delete'] as const) {
  app[method]('/mcp', auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: server runs stateless' },
      id: null,
    });
  });
}

app.listen(PORT, BIND_HOST, () => {
  console.log(`[mars-mcp] listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[mars-mcp] public URL   ${PUBLIC_URL}`);
  console.log(`[mars-mcp] stub tokens  ${verifier.size}`);
});
