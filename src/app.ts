import express, { type ErrorRequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { MarsAuthProvider, validRedirect } from './auth.js';
import { AuthStore } from './auth-store.js';
import { browserAuthRouter } from './auth-browser.js';
import { deviceAuthRouter } from './auth-device.js';
import { authHeaders, authRateLimit } from './auth-http.js';
import type { AuthConfig } from './auth-types.js';
import { registerMarsTools } from './tools.js';
import { registerMarsResources } from './resources.js';

const VERSION = '0.1.0';
const SERVICE = 'mars-mcp';
const SCOPES = ['mars.read'];

export function createApp(config: AuthConfig, options: { fetchDiscord?: typeof fetch } = {}) {
  const store = new AuthStore(config.databasePath);
  const provider = new MarsAuthProvider(store, config);
  const app = express();
  app.disable('x-powered-by');
  app.use(authHeaders);

  const oauthOptions = { provider, issuerUrl: new URL(config.issuer),
    resourceServerUrl: new URL(config.resource), scopesSupported: SCOPES, resourceName: 'Mars College MCP' };
  const metadata = { ...createOAuthMetadata(oauthOptions), issuer: config.issuer,
    grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'] };
  const protectedMetadata = { resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Mars College MCP' };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json(metadata);
  });
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, (_req, res) => { res.set('Access-Control-Allow-Origin', '*').json(protectedMetadata); });
  }
  app.get('/healthz', (_req, res) => { res.json({ ok: true, service: SERVICE, version: VERSION }); });

  // Bound parsers before the SDK's endpoints, without parsing unauthenticated MCP bodies.
  app.use(['/authorize', '/token', '/revoke'], express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 30 }));
  app.use('/register', express.json({ limit: '16kb' }));
  // Reject unsafe redirects before SDK error handling can redirect to them.
  app.use('/authorize', (req, res, next) => {
    const value: unknown = req.method === 'POST' ? req.body?.redirect_uri : req.query.redirect_uri;
    if (value !== undefined && (typeof value !== 'string' || !validRedirect(value))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Invalid redirect URI' }); return;
    }
    next();
  });
  app.use('/token', (req, res, next) => {
    if (req.body?.grant_type === 'authorization_code'
        && (typeof req.body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body.code_verifier))) {
      res.status(400).json({ error: 'invalid_grant' }); return;
    }
    next();
  });
  app.use(mcpAuthRouter(oauthOptions));
  app.use('/auth', deviceAuthRouter(store, config, provider));
  app.use('/auth', browserAuthRouter(store, config, options.fetchDiscord));

  // Browser MCP clients use explicit bearer credentials, never ambient cookies.
  app.use('/mcp', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'POST, GET, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID' });
      res.status(204).end(); return;
    }
    next();
  });
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: SCOPES,
    resourceMetadataUrl: `${config.issuer}/.well-known/oauth-protected-resource/mcp` });
  const parseJson = express.json({ limit: '1mb' });
  const mcpRate = authRateLimit(store, 'mcp', 300);
  app.post('/mcp', mcpRate, bearer, parseJson, async (req, res) => {
    const server = new McpServer({ name: SERVICE, version: VERSION }, { capabilities: { tools: {} } });
    registerMarsTools(server);
    registerMarsResources(server, req.auth!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Deliberately avoid serializing transport exceptions or requests containing secrets.
    transport.onerror = () => console.error(`[${SERVICE}] MCP transport error`);
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: server runs stateless' }, id: null });
  };
  app.get('/mcp', bearer, methodNotAllowed);
  app.delete('/mcp', bearer, methodNotAllowed);

  app.use((_req, res) => {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null });
  });
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const raw = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const status = typeof raw === 'number' && raw >= 400 && raw < 500 ? raw : 500;
    if (status === 500) console.error(`[${SERVICE}] internal request error`);
    if (req.path.startsWith('/auth') || ['/token', '/register', '/revoke', '/authorize'].includes(req.path)) {
      res.status(status).json({ error: status === 500 ? 'server_error' : 'invalid_request' }); return;
    }
    const parseError = error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed';
    res.status(status).json({ jsonrpc: '2.0', error: {
      code: status === 500 ? -32603 : parseError ? -32700 : -32600,
      message: status === 500 ? 'Internal server error' : parseError ? 'Parse error' : 'Invalid Request',
    }, id: null });
  };
  app.use(errors);
  return { app, store, provider };
}
