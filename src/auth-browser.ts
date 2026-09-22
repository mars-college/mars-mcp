import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { AuthConfig, AuthorizationCode, LoginFlow } from './auth-types.js';
import { AuthStore, hash, now, secret } from './auth-store.js';
import { discordConfigured } from './auth-config.js';
import { authHeaders, authRateLimit, escapeHtml, htmlPage } from './auth-http.js';

const COOKIE = 'mars_auth_browser';
const FLOW_TTL = 600;
const API = 'https://discord.com/api/v10';
const User = z.object({ id: z.string().regex(/^\d+$/), username: z.string().max(100) });
const Member = z.object({ roles: z.array(z.string().regex(/^\d+$/)), pending: z.boolean().optional() });

function cookie(req: Request): string {
  const value = req.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

function setCookie(res: Response, config: AuthConfig, value: string): void {
  res.cookie(COOKIE, value, { httpOnly: true, secure: config.issuer.startsWith('https:'),
    sameSite: 'lax', path: '/auth', maxAge: FLOW_TTL * 1000 });
}

function validCsrf(req: Request, flowId: string, action: string): boolean {
  const browser = cookie(req);
  const supplied: unknown = req.body?.csrf;
  if (!browser || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(hash(`${browser}:${flowId}:${action}`)));
}

function boundFlow(store: AuthStore, req: Request, flowId: unknown): LoginFlow | undefined {
  if (typeof flowId !== 'string' || flowId.length > 100 || !cookie(req)) return undefined;
  const flow = store.get<LoginFlow>('flow', flowId);
  return flow?.browserHash === hash(cookie(req)) ? flow : undefined;
}

function connectPage(res: Response, flow: LoginFlow, flowId: string, browser: string): void {
  const label = flow.kind === 'device' ? `Agent code: <strong>${escapeHtml(flow.userCode || '')}</strong>`
    : `Client: <strong>${escapeHtml(flow.clientName)}</strong><br>Return address: ${escapeHtml(flow.redirectUri || '')}`;
  htmlPage(res, 'Connect your Discord account', `<p>${label}</p><p>This client requests read access to Mars resources on your behalf. It cannot gain more access than your community roles permit.</p><p>Continue only if you started this request. Client names are supplied by clients, not verified identities.</p><form method="post" action="/auth/discord"><input type="hidden" name="flow" value="${flowId}"><input type="hidden" name="csrf" value="${hash(`${browser}:${flowId}:discord`)}"><button>Continue with Discord</button></form>`, 200, 'https://discord.com');
}

function deny(res: Response, flow: LoginFlow): void {
  if (flow.kind === 'oauth' && flow.redirectUri) {
    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    if (flow.state !== undefined) redirect.searchParams.set('state', flow.state);
    res.redirect(303, redirect.href);
  } else {
    htmlPage(res, 'Authorization denied', '<p>No agent access was granted. Return to your client to start again.</p>', 403);
  }
}

export function browserAuthRouter(store: AuthStore, config: AuthConfig, fetchDiscord: typeof fetch = fetch): express.Router {
  const router = express.Router();
  router.use(authHeaders, express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 }));
  router.use((req, res, next) => {
    if (!discordConfigured(config)) {
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Discord authentication is not configured' });
      return;
    }
    next();
  });

  router.get('/start', authRateLimit(store, 'start', 30), (req, res) => {
    const id = typeof req.query.flow === 'string' ? req.query.flow : '';
    const browser = cookie(req) || secret();
    const flow = store.transaction(() => {
      const value = store.get<LoginFlow>('flow', id);
      if (!value || value.kind !== 'oauth' || value.status !== 'pending'
          || (value.browserHash && value.browserHash !== hash(browser))) return undefined;
      value.browserHash = hash(browser);
      store.put('flow', id, value, value.expiresAt);
      return value;
    });
    if (!flow) {
      htmlPage(res, 'Authorization unavailable', '<p>This request expired or belongs to another browser. Start again from your client.</p>', 400);
      return;
    }
    setCookie(res, config, browser);
    connectPage(res, flow, id, browser);
  });

  router.get('/verify', authRateLimit(store, 'verify-form', 30), (_req, res) => {
    const browser = secret();
    setCookie(res, config, browser);
    htmlPage(res, 'Authorize your Mars agent', `<p>Enter the code displayed by your own agent. Never enter a code sent by somebody else.</p><form method="post" action="/auth/verify"><label for="user_code">Agent code</label> <input id="user_code" name="user_code" required maxlength="9" autocomplete="off"><input type="hidden" name="csrf" value="${hash(`${browser}::verify`)}"><button>Continue</button></form>`);
  });

  router.post('/verify', authRateLimit(store, 'verify', 20), (req, res) => {
    if (!validCsrf(req, '', 'verify') || typeof req.body.user_code !== 'string') {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const userCode = req.body.user_code.trim().toUpperCase();
    const browser = cookie(req);
    const claimed = store.transaction(() => {
      const mapping = store.get<{ flowId: string }>('user-code', hash(userCode));
      if (!mapping) return undefined;
      const flow = store.get<LoginFlow>('flow', mapping.flowId);
      if (!flow || flow.kind !== 'device' || flow.status !== 'pending' || flow.browserHash) return undefined;
      flow.browserHash = hash(browser);
      store.put('flow', mapping.flowId, flow, flow.expiresAt);
      store.delete('user-code', hash(userCode));
      return { flow, id: mapping.flowId };
    });
    if (!claimed) {
      htmlPage(res, 'Invalid agent code', '<p>The code is invalid, expired, or already claimed. Start again from your client.</p>', 400);
      return;
    }
    connectPage(res, claimed.flow, claimed.id, browser);
  });

  router.post('/discord', authRateLimit(store, 'discord', 20), (req, res) => {
    const flowId: unknown = req.body.flow;
    if (typeof flowId !== 'string' || !validCsrf(req, flowId, 'discord')) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const state = secret();
    const claimed = store.transaction(() => {
      const flow = boundFlow(store, req, flowId);
      if (!flow || flow.status !== 'pending') return false;
      flow.status = 'exchanging';
      store.put('flow', flowId, flow, flow.expiresAt);
      store.put('discord-state', hash(state), { flowId, browserHash: flow.browserHash }, flow.expiresAt);
      return true;
    });
    if (!claimed) { res.status(400).json({ error: 'invalid_request' }); return; }
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: config.discordClientId,
      redirect_uri: `${config.issuer}/auth/discord/callback`, response_type: 'code',
      scope: 'identify guilds.members.read', state, prompt: 'consent' }).toString();
    res.redirect(303, url.href);
  });

  router.get('/discord/callback', authRateLimit(store, 'callback', 30), async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const claimed = store.transaction(() => {
      const entry = store.get<{ flowId: string; browserHash: string }>('discord-state', hash(state));
      if (!state || !entry || !cookie(req) || entry.browserHash !== hash(cookie(req))) return undefined;
      const flow = boundFlow(store, req, entry.flowId);
      if (!flow || flow.status !== 'exchanging') return undefined;
      store.delete('discord-state', hash(state));
      return { flow, id: entry.flowId };
    });
    if (!claimed) { res.status(400).json({ error: 'invalid_request', error_description: 'Invalid or expired OAuth state' }); return; }
    const { flow, id } = claimed;
    try {
      if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 2048) throw new Error('Denied');
      const exchange = await fetchDiscord(`${API}/oauth2/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.discordClientId, client_secret: config.discordClientSecret,
          grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${config.issuer}/auth/discord/callback` }),
      });
      if (!exchange.ok) throw new Error('Discord exchange failed');
      const credentials = z.object({ access_token: z.string().min(1).max(4096) }).parse(await exchange.json());
      const options = { headers: { Authorization: `Bearer ${credentials.access_token}` }, redirect: 'error' as const };
      const userResponse = await fetchDiscord(`${API}/users/@me`, { ...options, signal: AbortSignal.timeout(15000) });
      if (!userResponse.ok) throw new Error('Discord user lookup failed');
      const user = User.parse(await userResponse.json());
      const memberResponse = await fetchDiscord(`${API}/users/@me/guilds/${encodeURIComponent(config.discordGuildId)}/member`, { ...options, signal: AbortSignal.timeout(15000) });
      if (!memberResponse.ok) throw new Error('Not a member');
      const member = Member.parse(await memberResponse.json());
      if (member.pending) throw new Error('Membership screening pending');
      flow.principal = { subject: user.id, username: user.username, membershipAt: now(),
        roles: [...new Set(['member', ...member.roles.flatMap(role => Object.hasOwn(config.roleMap, role) ? [config.roleMap[role]!] : [])])].sort() };
      flow.status = 'approval';
    } catch {
      // Never reflect upstream bodies, credentials, or OAuth codes to logs/clients.
      flow.status = 'denied';
    }
    if (!store.get<LoginFlow>('flow', id)) { res.status(400).json({ error: 'expired_token' }); return; }
    store.put('flow', id, flow, flow.expiresAt);
    if (flow.status === 'denied') { deny(res, flow); return; }
    res.redirect(303, `/auth/approve?flow=${encodeURIComponent(id)}`);
  });

  router.get('/approve', (req, res) => {
    const id = typeof req.query.flow === 'string' ? req.query.flow : '';
    const flow = boundFlow(store, req, id);
    if (!flow || flow.status !== 'approval' || !flow.principal) { res.status(403).json({ error: 'access_denied' }); return; }
    const who = flow.kind === 'device' ? `Agent code: <strong>${escapeHtml(flow.userCode || '')}</strong>`
      : `Client: <strong>${escapeHtml(flow.clientName)}</strong><br>Return address: ${escapeHtml(flow.redirectUri || '')}`;
    htmlPage(res, 'Approve Mars access', `<p>${who}</p><p>Discord account: ${escapeHtml(flow.principal.username)} (${escapeHtml(flow.principal.subject)})</p><p>Community roles: ${flow.principal.roles.map(escapeHtml).join(', ')}</p><p>Permission: read Mars resources allowed by your roles. Session lasts at most ${config.sessionTtl} seconds from the membership check.</p><p>Approve only a request you initiated.</p><form method="post" action="/auth/approve"><input type="hidden" name="flow" value="${id}"><input type="hidden" name="csrf" value="${hash(`${cookie(req)}:${id}:approve`)}"><button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`, 200, flow.redirectUri);
  });

  router.post('/approve', authRateLimit(store, 'approve', 20), (req, res) => {
    const id: unknown = req.body.flow;
    if (typeof id !== 'string' || !validCsrf(req, id, 'approve') || !['approve', 'deny'].includes(req.body.decision)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const result = store.transaction(() => {
      const flow = boundFlow(store, req, id);
      if (!flow || flow.status !== 'approval' || !flow.principal) return undefined;
      if (req.body.decision === 'deny' || flow.principal.membershipAt + config.sessionTtl <= now()) {
        flow.status = 'denied'; store.put('flow', id, flow, flow.expiresAt); return { flow };
      }
      if (flow.kind === 'device') {
        flow.status = 'approved'; store.put('flow', id, flow, flow.expiresAt); return { flow };
      }
      const code = secret();
      const grant: AuthorizationCode = { clientId: flow.clientId, redirectUri: flow.redirectUri!, resource: flow.resource,
        scope: flow.scope, codeChallenge: flow.codeChallenge!, principal: flow.principal };
      store.put('code', hash(code), grant, Math.min(now() + 60, flow.principal.membershipAt + config.sessionTtl));
      flow.status = 'consumed'; store.put('flow', id, flow, flow.expiresAt);
      return { flow, code };
    });
    if (!result) { res.status(403).json({ error: 'access_denied' }); return; }
    res.clearCookie(COOKIE, { path: '/auth', httpOnly: true, secure: config.issuer.startsWith('https:'), sameSite: 'lax' });
    if (result.flow.status === 'denied') { deny(res, result.flow); return; }
    if (result.code) {
      const redirect = new URL(result.flow.redirectUri!);
      redirect.searchParams.set('code', result.code);
      if (result.flow.state !== undefined) redirect.searchParams.set('state', result.flow.state);
      res.redirect(303, redirect.href);
    } else {
      htmlPage(res, 'Agent authorized', '<p>You may close this window and return to your agent. The credential is delivered privately to the initiating helper.</p>');
    }
  });
  return router;
}
