import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthStore, hash, now, secret } from '../src/auth-store.js';
import { MarsAuthProvider } from '../src/auth.js';
import type { AuthConfig, AuthorizationCode, Principal } from '../src/auth-types.js';

test('public OAuth registration, authorization, exchange, persistence and revocation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-oauth-'));
  let store = new AuthStore(join(dir, 'auth.sqlite'));
  const config: AuthConfig = {
    issuer: 'http://localhost', resource: 'http://localhost/mcp', databasePath: join(dir, 'auth.sqlite'),
    discordClientId: 'fixture', discordClientSecret: 'fixture', discordGuildId: 'fixture',
    roleMap: {}, sessionTtl: 900,
  };
  let provider = new MarsAuthProvider(store, config);
  const app = express();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(config.issuer), resourceServerUrl: new URL(config.resource), scopesSupported: ['mars.read'], clientRegistrationOptions: { rateLimit: false }, authorizationOptions: { rateLimit: false }, tokenOptions: { rateLimit: false }, revocationOptions: { rateLimit: false } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const metadata = { redirect_uris: ['http://127.0.0.1:7654/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'mars.read' };
  const register = (body: unknown) => fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const redirect of ['http://example.org/cb', 'https://example.org/cb#fragment', 'https://user@example.org/cb', 'file:///cb', 'https://*.example.org/cb']) {
    assert.equal((await register({ ...metadata, redirect_uris: [redirect] })).status, 400, redirect);
  }
  assert.equal((await register({ ...metadata, token_endpoint_auth_method: 'client_secret_basic' })).status, 400);
  assert.equal((await register({ ...metadata, scope: 'mars.write' })).status, 400);
  const registration = await register(metadata);
  assert.equal(registration.status, 201);
  const client = await registration.json() as OAuthClientInformationFull;
  const second = await (await register(metadata)).json() as OAuthClientInformationFull;
  assert.equal(provider.clientsStore.getClient('mars-agent-helper'), undefined);
  const verifier = secret();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const principal: Principal = { subject: 'discord:123', username: 'martian', roles: ['student'], membershipAt: now() - 100 };
  const authorize = (changes: Record<string, string> = {}) => {
    const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: metadata.redirect_uris[0]!, code_challenge: challenge, code_challenge_method: 'S256', scope: 'mars.read', resource: config.resource, ...changes });
    return fetch(`${origin}/authorize?${query}`, { redirect: 'manual' });
  };
  assert.match((await authorize()).headers.get('location') ?? '', /\/auth\/start\?flow=/);
  config.discordClientSecret = '';
  assert.equal((await authorize()).status, 503);
  config.discordClientSecret = 'fixture';
  assert.match((await authorize({ redirect_uri: 'http://127.0.0.1:7655/callback' })).headers.get('location') ?? '', /\/auth\/start\?flow=/);
  const withoutResource = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: metadata.redirect_uris[0]!, code_challenge: challenge, code_challenge_method: 'S256' });
  const missingResource = await fetch(`${origin}/authorize?${withoutResource}`, { redirect: 'manual' });
  assert.match(missingResource.headers.get('location') ?? '', /error=invalid_target/);
  for (const change of [{ scope: 'mars.write' }, { resource: 'https://other.example/mcp' }, { code_challenge: 'bad' }, { code_challenge_method: 'plain' }]) {
    const result = await authorize(change);
    assert.ok(result.status === 400 || result.headers.get('location')?.includes('error='));
  }
  const seed = (overrides: Partial<AuthorizationCode> = {}, expires = now() + 60) => {
    const code = secret();
    store.put('code', hash(code), { clientId: client.client_id, redirectUri: metadata.redirect_uris[0]!, resource: config.resource, scope: 'mars.read', codeChallenge: challenge, principal, ...overrides } satisfies AuthorizationCode, expires);
    return code;
  };
  const token = (code: string, changes: Record<string, string> = {}) => fetch(`${origin}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: metadata.redirect_uris[0]!, resource: config.resource, ...changes }),
  });
  for (const changes of [{ code_verifier: secret() }, { client_id: second.client_id }, { redirect_uri: 'http://127.0.0.1:7654/wrong' }, { resource: 'https://other.example/mcp' }, { resource: '' }]) {
    assert.equal((await token(seed(), changes)).status, 400);
  }
  assert.equal((await token(seed({}, now() - 1))).status, 400);
  assert.equal((await token(seed({ principal: { ...principal, membershipAt: now() - 901 } }))).status, 400);
  const code = seed();
  const exchange = await token(code);
  assert.equal(exchange.status, 200);
  const issued = await exchange.json() as { access_token: string; expires_in: number; refresh_token?: string };
  assert.ok(issued.expires_in <= 800 && issued.expires_in > 790);
  assert.equal(issued.refresh_token, undefined);
  assert.equal((await token(code)).status, 400);
  const info = await provider.verifyAccessToken(issued.access_token);
  assert.deepEqual(info.extra?.roles, ['student']);
  assert.equal(info.extra?.subject, principal.subject);
  assert.deepEqual(info.scopes, ['mars.read']);
  await assert.rejects(new MarsAuthProvider(store, { ...config, resource: 'https://other.example/mcp' }).verifyAccessToken(issued.access_token));
  const revoke = (id: string) => fetch(`${origin}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, token: issued.access_token }) });
  assert.equal((await revoke(second.client_id)).status, 200);
  assert.equal((await provider.verifyAccessToken(issued.access_token)).clientId, client.client_id);
  assert.equal((await revoke(client.client_id)).status, 200);
  await assert.rejects(provider.verifyAccessToken(issued.access_token));
  const persistent = provider.issueAccess(client.client_id, principal).access_token;
  const expired = secret();
  store.put('access', hash(expired), { clientId: client.client_id, resource: config.resource, scopes: ['mars.read'], principal, expiresAt: now() - 1 }, now() - 1);
  await assert.rejects(provider.verifyAccessToken(expired));
  const refresh = await fetch(`${origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, grant_type: 'refresh_token', refresh_token: secret() }) });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json() as { error: string }).error, 'unsupported_grant_type');
  store.close();
  store = new AuthStore(config.databasePath);
  provider = new MarsAuthProvider(store, config);
  assert.equal((await provider.clientsStore.getClient(client.client_id))?.client_id, client.client_id);
  assert.equal((await provider.verifyAccessToken(persistent)).extra?.username, 'martian');
  provider.revokeAccess(persistent);
  await assert.rejects(provider.verifyAccessToken(persistent));
});
