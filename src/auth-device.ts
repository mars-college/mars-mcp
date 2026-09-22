import { randomInt } from 'node:crypto';
import express from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthConfig, LoginFlow } from './auth-types.js';
import { AuthStore, hash, now, secret } from './auth-store.js';
import { MarsAuthProvider } from './auth.js';
import { discordConfigured } from './auth-config.js';
import { authHeaders, authRateLimit } from './auth-http.js';

export function deviceAuthRouter(store: AuthStore, config: AuthConfig, provider: MarsAuthProvider): express.Router {
  const router = express.Router();
  router.use(authHeaders, express.json({ limit: '4kb' }));
  router.post('/device', authRateLimit(store, 'device', 10), (_req, res) => {
    if (!discordConfigured(config)) {
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Discord authentication is not configured' }); return;
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const issued = store.transaction(() => {
      let userCode: string;
      do {
        const chars = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
        userCode = `${chars.slice(0, 4)}-${chars.slice(4)}`;
      } while (store.get('user-code', hash(userCode)));
      const flowId = secret();
      const deviceCode = secret();
      const expires = now() + 600;
      const flow: LoginFlow = { kind: 'device', clientId: 'mars-agent-helper', clientName: 'Mars agent helper',
        resource: config.resource, scope: 'mars.read', status: 'pending', userCode,
        expiresAt: expires, lastPoll: 0, pollInterval: 5 };
      store.put('flow', flowId, flow, expires);
      store.put('user-code', hash(userCode), { flowId }, expires);
      store.put('device-code', hash(deviceCode), { flowId }, expires);
      return { userCode, deviceCode };
    });
    res.json({ device_code: issued.deviceCode, user_code: issued.userCode,
      verification_uri: `${config.issuer}/auth/verify`, expires_in: 600, interval: 5 });
  });

  router.post('/token', authRateLimit(store, 'device-poll', 120), (req, res) => {
    if (typeof req.body?.device_code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.body.device_code)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const result = store.transaction(() => {
      const mapping = store.get<{ flowId: string }>('device-code', hash(req.body.device_code));
      const flow = mapping ? store.get<LoginFlow>('flow', mapping.flowId) : undefined;
      if (!mapping || !flow) return { error: 'expired_token' };
      if (flow.status === 'denied' || flow.status === 'consumed') return { error: 'access_denied' };
      const interval = flow.pollInterval || 5;
      if (now() - (flow.lastPoll || 0) < interval) {
        flow.lastPoll = now(); flow.pollInterval = interval + 5;
        store.put('flow', mapping.flowId, flow, flow.expiresAt);
        return { error: 'slow_down' };
      }
      if (flow.status === 'approved' && flow.principal) {
        if (flow.principal.membershipAt + config.sessionTtl <= now()) {
          flow.status = 'denied'; store.put('flow', mapping.flowId, flow, flow.expiresAt);
          return { error: 'expired_token' };
        }
        const tokens = provider.issueAccess(flow.clientId, flow.principal);
        flow.status = 'consumed'; delete flow.browserHash;
        store.put('flow', mapping.flowId, flow, flow.expiresAt);
        return tokens;
      }
      flow.lastPoll = now();
      store.put('flow', mapping.flowId, flow, flow.expiresAt);
      return { error: 'authorization_pending' };
    });
    res.status('error' in result ? 400 : 200).json(result);
  });

  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: ['mars.read'],
    resourceMetadataUrl: `${config.issuer}/.well-known/oauth-protected-resource/mcp` });
  router.get('/me', bearer, (req, res) => {
    res.json({ subject: req.auth!.extra?.subject, username: req.auth!.extra?.username,
      roles: req.auth!.extra?.roles, expires_at: req.auth!.expiresAt });
  });
  router.post('/revoke', bearer, (req, res) => {
    provider.revokeAccess(req.auth!.token);
    res.status(204).end();
  });

  router.use(((err, _req, res, next) => {
    if (res.headersSent) { next(err); return; }
    if (err instanceof OAuthError) { res.status(400).json(err.toResponseObject()); return; }
    next(err);
  }) as express.ErrorRequestHandler);
  return router;
}
