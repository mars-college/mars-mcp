import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import type { AuthConfig } from '../src/auth-types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';


interface BrowserFixture {
  config: AuthConfig;
  origin: string;
  browse(path: string, fields?: Record<string, string>): Promise<Response>;
  jsonPost(path: string, payload: unknown): Promise<Response>;
}
async function fixture(t: TestContext, membership = true, roles: string[] = ['22', '99']): Promise<BrowserFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'mars-browser-'));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const config: AuthConfig = { issuer: origin, resource: `${origin}/mcp`, databasePath: join(dir, 'auth.sqlite'),
    discordClientId: '1', discordClientSecret: 'fixture-secret', discordGuildId: '3', roleMap: { '22': 'season:2022', '77': 'demo-reader' }, sessionTtl: 900 };
  const fetchDiscord: typeof fetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'private-discord-token' });
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer private-discord-token');
    if (url.endsWith('/users/@me')) return Response.json({ id: '42', username: 'Test Martian' });
    if (url.endsWith('/users/@me/guilds/3/member')) {
      return membership ? Response.json({ roles }) : Response.json({ message: 'Not a member' }, { status: 404 });
    }
    throw new Error('Unexpected Discord request');
  };
  const { app, store } = createApp(config, { fetchDiscord });
  server.on('request', app);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(dir, { recursive: true });
  });
  let cookie = '';
  const browse = async (path: string, fields?: Record<string, string>) => {
    const response = await fetch(new URL(path, origin), { redirect: 'manual', method: fields ? 'POST' : 'GET',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: fields ? new URLSearchParams(fields) : undefined });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  const jsonPost = (path: string, payload: unknown) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'manual',
  });
  return { config, origin, browse, jsonPost };
}

function fields(html: string): Record<string, string> {
  return Object.fromEntries([...html.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(match => [match[1]!, match[2]!]));
}

async function discordCallback(f: BrowserFixture, connect: Response) {
  const redirect = await f.browse('/auth/discord', fields(await connect.text()));
  assert.equal(redirect.status, 303);
  const discordUrl = new URL(redirect.headers.get('location')!);
  assert.equal(discordUrl.origin, 'https://discord.com');
  const state = discordUrl.searchParams.get('state')!;
  assert.equal((await f.browse('/auth/discord/callback?state=wrong&code=x')).status, 400);
  // Another browser cannot consume a legitimate callback.
  const callback = `/auth/discord/callback?${new URLSearchParams({ state, code: 'fixture-code' })}`;
  assert.equal((await fetch(f.origin + callback, { redirect: 'manual' })).status, 400);
  const complete = await f.browse(callback);
  assert.equal((await f.browse(callback)).status, 400);
  return complete;
}

test('OAuth discovery through Discord consent to scoped MCP access, then revoke', async t => {
  const f = await fixture(t);
  const unauth = await f.jsonPost('/mcp', {});
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
  const metadata = await (await fetch(`${f.origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, f.origin);
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code']);
  const registered = await f.jsonPost('/register', { client_name: 'Test MCP client', redirect_uris: ['http://127.0.0.1:4567/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  assert.deepEqual(client.grant_types, ['authorization_code']);
  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback',
    resource: f.config.resource, response_type: 'code', scope: 'mars.read', state: 'client-state',
    code_challenge: challenge, code_challenge_method: 'S256' });
  const start = await f.browse(`/authorize?${params}`);
  assert.equal(start.status, 302);
  const connect = await f.browse(start.headers.get('location')!);
  const callback = await discordCallback(f, connect);
  assert.equal(callback.status, 303);
  const approval = await f.browse(callback.headers.get('location')!);
  const approvalHtml = await approval.text();
  assert.match(approvalHtml, /Test Martian/);
  assert.match(approvalHtml, /season:2022/);
  assert.equal((await f.browse('/auth/approve', { ...fields(approvalHtml), csrf: 'wrong', decision: 'approve' })).status, 400);
  const result = await f.browse('/auth/approve', { ...fields(approvalHtml), decision: 'approve' });
  const redirect = new URL(result.headers.get('location')!);
  assert.equal(redirect.origin, 'http://127.0.0.1:9876');
  assert.equal(redirect.searchParams.get('state'), 'client-state');
  const tokenRequest = { client_id: client.client_id, grant_type: 'authorization_code', code: redirect.searchParams.get('code')!,
    code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource: f.config.resource };
  const tokenResponse = await f.browse('/token', tokenRequest);
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.equal(token.token_type, 'Bearer');
  assert.equal((await f.browse('/token', tokenRequest)).status, 400);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const identity = await (await fetch(`${f.origin}/auth/me`, { headers })).json();
  assert.equal(identity.subject, '42');
  assert.deepEqual(identity.roles, ['member', 'season:2022']);
  const tools = await fetch(`${f.origin}/mcp`, { method: 'POST', headers: { ...headers,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(tools.status, 200);
  assert.match(await tools.text(), /mars_lookup/);
  assert.equal((await fetch(`${f.origin}/auth/revoke`, { method: 'POST', headers })).status, 204);
  assert.equal((await fetch(`${f.origin}/auth/me`, { headers })).status, 401);
});

test('device flow requires explicit consent, single-use delivery, and enforces poll backoff', async t => {
  const f = await fixture(t);
  const device = await (await f.jsonPost('/auth/device', {})).json();
  const poll = () => f.jsonPost('/auth/token', { device_code: device.device_code });
  const verify = await f.browse('/auth/verify');
  const connect = await f.browse('/auth/verify', { ...fields(await verify.text()), user_code: device.user_code });
  const callback = await discordCallback(f, connect);
  const approval = await f.browse(callback.headers.get('location')!);
  const approvalFields = fields(await approval.text());
  assert.equal((await (await poll()).json()).error, 'authorization_pending');
  assert.equal((await (await poll()).json()).error, 'slow_down');
  // Advancing only Date.now avoids real sleeps while exercising the same expiry boundary.
  const time = Date.now();
  t.mock.method(Date, 'now', () => time + 11_000);
  const approved = await f.browse('/auth/approve', { ...approvalFields, decision: 'approve' });
  assert.equal(approved.status, 200);
  const tokens = await (await poll()).json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.expires_in <= 889);
  assert.equal((await (await poll()).json()).error, 'access_denied');
  const headers = { Authorization: `Bearer ${tokens.access_token}` };
  assert.equal((await fetch(`${f.origin}/auth/me`, { headers })).status, 200);
  t.mock.method(Date, 'now', () => time + 901_000);
  assert.equal((await fetch(`${f.origin}/auth/me`, { headers })).status, 401);
});

test('non-members cannot mint device credentials', async t => {
  const f = await fixture(t, false);
  const device = await (await f.jsonPost('/auth/device', {})).json();
  const verify = await f.browse('/auth/verify');
  const connect = await f.browse('/auth/verify', { ...fields(await verify.text()), user_code: device.user_code });
  const result = await discordCallback(f, connect);
  assert.equal(result.status, 403);
  assert.equal((await (await f.jsonPost('/auth/token', { device_code: device.device_code })).json()).error, 'access_denied');
});

test('missing Discord config fails closed and malicious redirect errors never redirect', async t => {
  const f = await fixture(t);
  const registration = await (await f.jsonPost('/register', { redirect_uris: ['http://127.0.0.1:4567/callback'], token_endpoint_auth_method: 'none' })).json();
  const unsafe = await f.browse(`/authorize?${new URLSearchParams({ client_id: registration.client_id,
    redirect_uri: 'http://127.0.0.1:4567/callback#fragment', response_type: 'bad' })}`);
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.headers.get('location'), null);
  f.config.discordClientSecret = '';
  assert.equal((await f.jsonPost('/auth/device', {})).status, 503);
  assert.equal((await f.browse('/healthz')).status, 200);
});

test('Discord-inherited roles gate discovery and reads, including after role removal', async t => {
  const discordRoles = ['77'];
  const f = await fixture(t, true, discordRoles);
  const uri = 'mars://demo/role-gated';
  const missing = 'mars://demo/not-registered';
  const login = async () => {
    const device = await (await f.jsonPost('/auth/device', {})).json();
    const verify = await f.browse('/auth/verify');
    const connect = await f.browse('/auth/verify', { ...fields(await verify.text()), user_code: device.user_code });
    const callback = await discordCallback(f, connect);
    const approval = await f.browse(callback.headers.get('location')!);
    assert.equal((await f.browse('/auth/approve', { ...fields(await approval.text()), decision: 'approve' })).status, 200);
    const response = await f.jsonPost('/auth/token', { device_code: device.device_code });
    assert.equal(response.status, 200);
    const { access_token } = await response.json();
    const headers = { Authorization: `Bearer ${access_token}` };
    const client = new Client({ name: 'rbac-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(f.config.resource), { requestInit: { headers } }));
    t.after(() => client.close());
    return { client, headers };
  };

  const reader = await login();
  discordRoles.splice(0); // Discord role removal affects the next membership check.
  const member = await login();
  const [allowedList, deniedList] = await Promise.all([reader.client.listResources(), member.client.listResources()]);
  assert.deepEqual(allowedList.resources.map(resource => resource.uri), [uri]);
  assert.deepEqual(deniedList.resources, []);
  assert.deepEqual((await member.client.listResourceTemplates()).resourceTemplates, []);
  const read = await reader.client.readResource({ uri });
  assert.match(JSON.stringify(read.contents), /Copper Finch/);
  const allowedTool = await reader.client.callTool({ name: 'read_resource', arguments: { uri } });
  assert.notEqual(allowedTool.isError, true);
  assert.match(JSON.stringify(allowedTool.content), /Copper Finch/);
  const hiddenList = await member.client.callTool({ name: 'list_resources', arguments: {} });
  assert.deepEqual(hiddenList.structuredContent, { resources: [] });
  const deniedTool = await member.client.callTool({ name: 'read_resource', arguments: { uri } });
  const missingTool = await member.client.callTool({ name: 'read_resource', arguments: { uri: missing } });
  assert.equal(deniedTool.isError, true);
  assert.deepEqual(deniedTool.content, missingTool.content);
  assert.doesNotMatch(JSON.stringify(deniedTool), /Copper Finch|Mars role-gated demonstration/);
  await assert.rejects(member.client.readResource({ uri }));
  await assert.rejects(member.client.readResource({ uri: missing }));
  await assert.rejects(reader.client.readResource({ uri: 'file:///etc/passwd' }));
  // Requests by another principal must not mutate this session's allowed set.
  assert.deepEqual((await reader.client.listResources()).resources.map(resource => resource.uri), [uri]);
  assert.equal((await fetch(`${f.origin}/auth/revoke`, { method: 'POST', headers: reader.headers })).status, 204);
  const revoked = await fetch(f.config.resource, { method: 'POST', headers: { ...reader.headers,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }) });
  assert.equal(revoked.status, 401);
});
