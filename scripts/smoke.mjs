// Finite HTTP smoke of the real app with synthetic Discord responses only.
// Never reads .env, contacts Discord, mounts data, or prints credentials.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/app.js';

const directory = mkdtempSync(join(tmpdir(), 'mars-smoke-'));
const server = createServer();
const clients = [];
let store;
let roleIds = ['77'];
const deadline = setTimeout(() => {
  console.error('FAIL: smoke exceeded 30 seconds');
  process.exit(1);
}, 30_000);
deadline.unref();
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = {
    issuer: origin, resource: `${origin}/mcp`, databasePath: join(directory, 'auth.sqlite'),
    discordClientId: '1', discordClientSecret: 'synthetic-only', discordGuildId: '3',
    roleMap: { '77': 'demo-reader' }, sessionTtl: 900,
  };
  const fixture = async (input) => {
    const url = String(input);
    if (url === 'https://discord.com/api/v10/oauth2/token') return Response.json({ access_token: 'synthetic-upstream' });
    if (url === 'https://discord.com/api/v10/users/@me') return Response.json({ id: '42', username: 'Synthetic Martian' });
    if (url === 'https://discord.com/api/v10/users/@me/guilds/3/member') return Response.json({ roles: roleIds });
    throw new Error('Unexpected upstream URL in isolated smoke');
  };
  const runtime = createApp(config, { fetchDiscord: fixture });
  store = runtime.store;
  server.on('request', runtime.app);
  const request = (path, options = {}) => fetch(new URL(path, origin), {
    redirect: 'manual', signal: AbortSignal.timeout(5_000), ...options,
  });
  const post = (path, value) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/.well-known/oauth-authorization-server')).status, 200);
  assert.equal((await request('/.well-known/oauth-protected-resource/mcp')).status, 200);
  const denial = await post('/mcp', {});
  assert.equal(denial.status, 401);
  assert.match(denial.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  console.log('PASS health, OAuth discovery, anonymous MCP denial');

  // Follow actual browser/consent routes; only upstream Discord is synthetic.
  async function login() {
    let cookie = '';
    const browse = async (path, fields) => {
      const response = await request(path, {
        method: fields ? 'POST' : 'GET',
        headers: { ...(cookie ? { Cookie: cookie } : {}),
          ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: fields ? new URLSearchParams(fields) : undefined,
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    };
    const fields = html => Object.fromEntries([...html.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)]
      .map(match => [match[1], match[2]]));
    const registration = await post('/register', { client_name: 'Mars isolated smoke',
      redirect_uris: ['http://127.0.0.1:4567/callback'], token_endpoint_auth_method: 'none' });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const verifier = randomBytes(32).toString('base64url');
    const redirectUri = 'http://127.0.0.1:4567/callback';
    const start = await browse(`/authorize?${new URLSearchParams({ client_id: client.client_id,
      redirect_uri: redirectUri, resource: config.resource, response_type: 'code', scope: 'mars.read',
      state: 'isolated-smoke', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' })}`);
    assert.equal(start.status, 302);
    const connect = await browse(start.headers.get('location'));
    const discord = await browse('/auth/discord', fields(await connect.text()));
    assert.equal(discord.status, 303);
    const discordUrl = new URL(discord.headers.get('location'));
    assert.equal(discordUrl.origin, 'https://discord.com');
    const callback = await browse(`/auth/discord/callback?${new URLSearchParams({
      state: discordUrl.searchParams.get('state'), code: 'synthetic-code',
    })}`);
    assert.equal(callback.status, 303);
    const consent = await browse(callback.headers.get('location'));
    const approved = await browse('/auth/approve', { ...fields(await consent.text()), decision: 'approve' });
    assert.equal(approved.status, 303);
    const returned = new URL(approved.headers.get('location'));
    assert.equal(returned.searchParams.get('state'), 'isolated-smoke');
    const exchanged = await browse('/token', { client_id: client.client_id, grant_type: 'authorization_code',
      code: returned.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirectUri, resource: config.resource });
    assert.equal(exchanged.status, 200);
    const token = await exchanged.json();
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const mcp = new Client({ name: 'mars-smoke', version: '1.0' });
    clients.push(mcp);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(config.resource), { requestInit: { headers } }));
    return { mcp, headers, clientId: client.client_id, token: token.access_token };
  }
  const reader = await login();
  const uri = 'mars://demo/role-gated';
  assert.deepEqual((await reader.mcp.listResources()).resources.map(value => value.uri), [uri]);
  assert.match(JSON.stringify((await reader.mcp.readResource({ uri })).contents), /Copper Finch/);
  const tool = await reader.mcp.callTool({ name: 'read_resource', arguments: { uri } });
  assert.notEqual(tool.isError, true);
  console.log('PASS synthetic Discord → PKCE → consent → native MCP list/read and helper tool');
  roleIds = [];
  const member = await login();
  assert.deepEqual((await member.mcp.listResources()).resources, []);
  const hidden = await member.mcp.callTool({ name: 'read_resource', arguments: { uri } });
  const missing = await member.mcp.callTool({ name: 'read_resource', arguments: { uri: 'mars://demo/missing' } });
  assert.equal(hidden.isError, true);
  assert.deepEqual(hidden.content, missing.content);
  await assert.rejects(member.mcp.readResource({ uri }));
  console.log('PASS role removal on fresh login; hidden resource indistinguishable from missing');
  const revoked = await request('/revoke', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: reader.clientId, token: reader.token }) });
  assert.equal(revoked.status, 200);
  assert.equal((await request('/auth/me', { headers: reader.headers })).status, 401);
  console.log('PASS token revocation; private archives never loaded');
  console.log('LIMIT: isolated synthetic Discord fixture, NOT a real Discord login or deployed-host proof');
} finally {
  clearTimeout(deadline);
  await Promise.allSettled(clients.map(client => client.close()));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store?.close();
  rmSync(directory, { recursive: true, force: true });
}
