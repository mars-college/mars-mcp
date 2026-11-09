import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { hash } from '../src/auth-store.js';
import type { AuthConfig } from '../src/auth-types.js';
import { mkdtemp, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoMedia } from '../src/cuelight-video.js';
import { createHash } from 'node:crypto';

async function fakeExtractor(t: { after: (fn: () => Promise<void>) => void }, behavior: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mars-video-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'yt-dlp');
  await writeFile(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);\n${behavior}\n`);
  await chmod(binary, 0o700);
  return { ytDlpPath: binary, videoScratchDir: join(dir, 'scratch') };
}

const config: AuthConfig = { issuer: 'http://127.0.0.1:4400', resource: 'http://127.0.0.1:4400/mcp', databasePath: ':memory:', discordClientId: '', discordClientSecret: '', discordGuildId: '', roleMap: {}, sessionTtl: 900,
  servicePrincipals: [{ name: 'fixture', tokenSha256: hash('fixture-bearer'), roles: ['demo-reader', 'mars-2027'] }, { name: 'empty', tokenSha256: hash('empty-bearer'), roles: [] }] };

test('service bearers accept hashes, reject unknowns, filter roles and cannot puppet users', async t => {
  const { app, store, provider } = createApp(config);
  const server = createServer(app).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); store.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  async function rpc(token: string, method: string, params = {}) {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, text: await response.text() };
  }
  assert.equal((await provider.verifyAccessToken('fixture-bearer')).extra?.subject, 'service:fixture');
  assert.equal((await rpc('wrong', 'tools/list')).status, 401);
  assert.match((await rpc('fixture-bearer', 'resources/list')).text, /mars:\/\/demo\/role-gated/);
  assert.doesNotMatch((await rpc('empty-bearer', 'resources/list')).text, /Copper Finch|role-gated/);
  assert.doesNotMatch((await rpc('empty-bearer', 'tools/list')).text, /cuelight_nodes|character_create/);
  assert.match((await rpc('fixture-bearer', 'tools/call', { name: 'character_create', arguments: { name: 'Test', description: 'Test' } })).text, /service principals cannot/);
});

test('Cuelight fake assigns web media by unique human name and forwards generation', async t => {
  const videoOptions = await fakeExtractor(t, "console.error('Unsupported URL: fixture');process.exit(1)");
  let reportUnavailable = false;
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const fake: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer scoped');
    if (init?.method === 'PUT') assert.equal(new Headers(init.headers).get('If-Match'), '"generation:7"');
    const url = String(input); calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (reportUnavailable && url.endsWith('/status')) return new Response('', { status: 503 });
    return Response.json(url.includes('/nodes?') ? { items: [{ id: 'test-node', name: 'Fixture Screen', desiredGeneration: 7 }], page: {} }
      : url.includes('/media?') ? { items: [], page: {} }
      : url.endsWith('/media') ? { id: 'web-media', kind: 'web' }
      : url.endsWith('/status') ? { observedGeneration: 8, reportedAt: new Date().toISOString(), renderingReleaseDigest: 'digest', currentContent: { state: 'playing', releaseDigest: 'digest' } }
      : { mediaId: 'web-media', desiredGeneration: 8, releaseDigest: 'digest' });
  };
  const { app, store } = createApp(config, { ...videoOptions, cuelightUrl: 'https://cuelight.invalid', cuelightToken: 'scoped', fetchIntegration: fake });
  const server = createServer(app).listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(() => { server.close(); store.close(); }); const address = server.address(); assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer fixture-bearer', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cuelight_play', arguments: { node: 'fixture screen', url: 'https://www.youtube.com/watch?v=fixture' } } }) });
  const text = await response.text();
  assert.match(text, /web-media/);
  assert.match(text, /\\?"playing\\?":true/);
  assert.match(text, /\\?"assignedGeneration\\?":8/);
  assert.deepEqual(calls.find(call => call.method === 'PUT')?.body, { mediaId: 'web-media', expectedGeneration: 7, deliveryMode: 'stream' });
  reportUnavailable = true;
  const unconfirmed = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer fixture-bearer', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cuelight_play', arguments: { node: 'Fixture Screen', url: 'https://example.com/' } } }) });
  const unconfirmedText = await unconfirmed.text();
  assert.match(unconfirmedText, /\\?"playing\\?":false/);
  assert.match(unconfirmedText, /assignment succeeded but playback is unconfirmed/);
  const wrapper = await fetch(`http://127.0.0.1:${address.port}/cuelight/youtube/jfKfPfyJRdk`);
  assert.equal(wrapper.status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/cuelight/youtube/not-valid`)).status, 404);
});

test('video importer uploads real bytes, reuses source and digest, cleans scratch', async t => {
  const options = await fakeExtractor(t, `if(a.includes('--dump-single-json')) console.log(JSON.stringify({duration:30,title:'Fixture'}));else fs.writeFileSync(a[a.indexOf('-o')+1],'fixture-video');`);
  let media: { id: string; kind: string; tags?: string[]; artifact: { digest: string } } | undefined;
  let uploads = 0;
  const request = async (path: string, method?: string, raw?: unknown) => {
    const body = raw as { length?: number; kind: string; assetId: string; tags: string[]; playback: unknown };
    if (path.includes('/media?')) return { items: media ? [media] : [], page: {} };
    if (path === '/uploads') { uploads++; assert.equal(body.length, 13); return { id: 'upload' }; }
    if (path.endsWith('/complete')) return { id: 'asset' };
    assert.equal(path, '/media'); assert.equal(body.kind, 'file'); assert.equal(body.assetId, 'asset');
    assert.deepEqual(body.playback, { fit: 'fit', loop: true, muted: true, volume: 0, orientation: 0 });
    media = { ...body, id: 'uploaded-media', artifact: { digest: 'digest' } }; return media;
  };
  const send: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Upload-Offset'), '0');
    assert.equal(Buffer.from(init?.body as Uint8Array).toString(), 'fixture-video');
    return new Response(null, { status: 204 });
  };
  const first = await videoMedia('https://video.invalid/fixture', options, request, send, 'https://cuelight.invalid', 'scoped');
  assert.equal(first.kind, 'file'); assert.equal(first.id, 'uploaded-media');
  assert.equal((await videoMedia('https://video.invalid/fixture', options, request, send)).id, first.id);
  assert.equal(uploads, 1);
  assert.deepEqual(await readdir(options.videoScratchDir), []);
  media = { id: 'same-digest', kind: 'file', artifact: { digest: createHash('sha256').update('fixture-video').digest('hex') } };
  assert.equal((await videoMedia('https://video.invalid/other', options, request, send)).id, 'same-digest');
  assert.equal(uploads, 1);
});

for (const [name, behavior, expected] of [
  ['oversize', `console.log(JSON.stringify({duration:30,filesize:300*1024*1024}))`, /Video size exceeds/],
  ['duration', `console.log(JSON.stringify({duration:901}))`, /Video duration exceeds/],
  ['extractor failure', `console.error('unavailable');process.exit(1)`, /Video extractor failed/],
] as const) test(`video importer rejects ${name} without uploading`, async t => {
  const options = await fakeExtractor(t, behavior);
  const request = async () => ({ items: [], page: {} });
  await assert.rejects(videoMedia('https://video.invalid/fixture', options, request, fetch), expected);
});

test('video importer rejects oversized downloaded file and cleans scratch', async t => {
  const options = await fakeExtractor(t, `if(a.includes('--dump-single-json'))console.log(JSON.stringify({duration:30}));else {const p=a[a.indexOf('-o')+1];fs.writeFileSync(p,'x');fs.truncateSync(p,257*1024*1024);}`);
  await assert.rejects(videoMedia('https://video.invalid/fixture', options, async () => ({ items: [], page: {} }), fetch), /Video size exceeds/);
  assert.deepEqual(await readdir(options.videoScratchDir), []);
});

test('puppet tools use authenticated numeric Discord subject and gateway bearer for every operation', async t => {
  const calls: { url: string; method?: string; body?: Record<string, unknown> }[] = [];
  const fake: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer gateway-secret');
    calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ ok: true });
  };
  const { app, store, provider } = createApp(config, { gatewayUrl: 'http://gateway.invalid', gatewayToken: 'gateway-secret', fetchIntegration: fake });
  const token = provider.issueAccess('fixture-client', { subject: '123456789', username: 'fixture', roles: ['mars-2027'], membershipAt: Math.floor(Date.now()/1000) }).access_token;
  const server = createServer(app).listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(() => { server.close(); store.close(); }); const address = server.address(); assert(address && typeof address !== 'string');
  for (const [name, args] of [['characters_list', {}], ['character_create', { name: 'Fixture', description: 'Synthetic' }], ['character_update', { id: 'char', description: 'Changed' }], ['character_delete', { id: 'char' }], ['character_say', { id: 'char', channelId: '987', content: 'Hello' }], ['character_mentions', { id: 'char', after: '10' }]] as const) {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.doesNotMatch(await response.text(), /isError/);
  }
  assert.equal(calls.length, 6);
  for (const call of calls.filter(call => call.method !== 'GET')) assert.equal(call.body?.actorDiscordId, '123456789');
  assert.match(calls.at(-1)!.url, /actorDiscordId=123456789&after=10/);
});
