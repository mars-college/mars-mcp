import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { videoMedia, type VideoOptions } from './cuelight-video.js';

export interface IntegrationOptions extends VideoOptions {
  cuelightUrl?: string;
  cuelightToken?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  fetchIntegration?: typeof fetch;
}

export function integrationEnvironment(): IntegrationOptions {
  return { cuelightUrl: process.env.CUELIGHT_URL, cuelightToken: process.env.CUELIGHT_TOKEN,
    gatewayUrl: process.env.MARS_GATEWAY_URL, gatewayToken: process.env.MARS_GATEWAY_TOKEN,
    ytDlpPath: process.env.CUELIGHT_YT_DLP, ffmpegPath: process.env.CUELIGHT_FFMPEG,
    videoScratchDir: process.env.CUELIGHT_VIDEO_SCRATCH };
}


export function registerIntegrationTools(server: McpServer, auth: AuthInfo, options: IntegrationOptions): void {
  if (!Array.isArray(auth.extra?.roles) || !auth.extra.roles.includes('mars-2027')) return;
  const send = options.fetchIntegration ?? fetch;
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const failure = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
  async function request(base: string | undefined, token: string | undefined, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    if (!base || !token) throw new Error('Integration is not configured');
    const response = await send(`${base.replace(/\/$/, '')}${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
    return response.status === 204 ? {} : await response.json();
  }
  const cuelight = (path: string, method?: string, body?: unknown, headers?: Record<string, string>) =>
    request(options.cuelightUrl, options.cuelightToken, `/api/v1${path}`, method, body, headers);
  async function nodes(): Promise<{ id: string; name: string; desiredGeneration: number }[]> {
    const items: { id: string; name: string; desiredGeneration: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), desiredGeneration: z.number().int().nonnegative() })),
        page: z.object({ nextCursor: z.string().nullish() }).optional() })
        .parse(await cuelight(`/nodes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      items.push(...page.items);
      cursor = page.page?.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }
  const guarded = <T,>(fn: (args: T) => Promise<unknown>) => async (args: T) => {
    try { return result(await fn(args)); } catch (error) {
      return failure(error instanceof Error && /^(Upstream HTTP \d+|Integration is not configured|Node name .*|Video .*|Unsupported video URL)$/.test(error.message)
        ? error.message : 'Integration request failed');
    }
  };
  server.registerTool('cuelight_nodes', { description: 'List addressable Cuelight nodes by human name.', inputSchema: {} }, guarded(async () => ({ nodes: await nodes() })));
  server.registerTool('cuelight_play', { description: 'Download and upload a video URL (MP4 H264/AAC, 720p, maximum 900 seconds/256 MiB), or assign an unsupported non-video web page. Bounded download: metadata 30 seconds plus file 120 seconds. Returns generation and fresh player acknowledgement.',
    inputSchema: { node: z.string().min(1).max(200), url: z.string().url().refine(value => {
      const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    }) } }, guarded(async ({ node, url }) => {
    const matches = (await nodes()).filter(item => item.name.toLowerCase() === node.toLowerCase());
    if (matches.length !== 1) throw new Error('Node name must match exactly one node');
    const target = matches[0]!;
    const media = await videoMedia(url, options, cuelight, send, options.cuelightUrl, options.cuelightToken);
    const assignment = z.object({ desiredGeneration: z.number(), releaseDigest: z.string() }).passthrough().parse(await cuelight(`/nodes/${encodeURIComponent(target.id)}/assignment`, 'PUT',
      { mediaId: media.id, expectedGeneration: target.desiredGeneration, deliveryMode: 'stream' },
      { 'Idempotency-Key': randomUUID(), 'If-Match': `"generation:${target.desiredGeneration}"` }));
    const deadline = Date.now() + 10000;
    let player: unknown;
    let playing = false;
    let reportError: string | undefined;
    do {
      try {
        const status = z.object({
          observedGeneration: z.number(), reportedAt: z.string(),
          renderingReleaseDigest: z.string().nullish(),
          currentContent: z.object({ state: z.string(), releaseDigest: z.string().optional() }).passthrough().nullish(),
        }).passthrough().parse(await cuelight(`/nodes/${encodeURIComponent(target.id)}/status`));
        player = status;
        playing = status.observedGeneration === assignment.desiredGeneration
          && status.renderingReleaseDigest === assignment.releaseDigest
          && status.currentContent?.releaseDigest === assignment.releaseDigest
          && status.currentContent.state === 'playing'
          && Date.now() - Date.parse(status.reportedAt) < 30000;
        if (playing) break;
      } catch {
        reportError = 'Player report unavailable; assignment succeeded but playback is unconfirmed';
        break;
      }
      if (Date.now() >= deadline) break;
      await delay(1000);
    } while (Date.now() < deadline);
    return { node: target, url, mediaId: media.id, mediaKind: media.kind, mediaDigest: media.artifact?.digest,
      assignedGeneration: assignment.desiredGeneration, assignment, playing, player, reportError };
  }));

  const subject = auth.extra?.subject;
  const actor = typeof subject === 'string' && /^\d+$/.test(subject) ? subject : undefined;
  const gateway = async (path: string, method = 'GET', body?: Record<string, unknown>) => {
    if (!actor) throw new Error('Discord user authentication required');
    return request(options.gatewayUrl, options.gatewayToken, path, method, body && { ...body, actorDiscordId: actor });
  };
  const userOnly = <T,>(fn: (args: T) => Promise<unknown>) => async (args: T) => actor
    ? guarded(fn)(args) : failure('Discord user authentication required; service principals cannot manage characters');
  const id = z.string().min(1).max(200);
  const profile = { name: z.string().min(1).max(80), description: z.string().max(2000), avatarUrl: z.string().url().optional() };
  server.registerTool('characters_list', { description: 'List community characters (Discord users only).', inputSchema: {} }, userOnly(() => gateway('/v1/characters')));
  server.registerTool('character_create', { description: 'Create your external puppet character.', inputSchema: profile }, userOnly(args => gateway('/v1/characters', 'POST', args)));
  server.registerTool('character_update', { description: 'Update a character you own.', inputSchema: { id, name: profile.name.optional(), description: profile.description.optional(), avatarUrl: profile.avatarUrl } }, userOnly(({ id, ...args }) => gateway(`/v1/characters/${encodeURIComponent(id)}`, 'PATCH', args)));
  server.registerTool('character_delete', { description: 'Delete a character you own.', inputSchema: { id } }, userOnly(({ id }) => gateway(`/v1/characters/${encodeURIComponent(id)}`, 'DELETE', {})));
  server.registerTool('character_say', { description: 'Speak as a character you own in an allowed channel.', inputSchema: { id, channelId: z.string().regex(/^\d+$/), content: z.string().min(1).max(2000), replyToMessageId: z.string().regex(/^\d+$/).optional() } }, userOnly(({ id, ...args }) => gateway(`/v1/characters/${encodeURIComponent(id)}/messages`, 'POST', args)));
  server.registerTool('character_mentions', { description: 'Read mentions of a character you own.', inputSchema: { id, after: z.string().regex(/^\d+$/).optional() } }, userOnly(({ id, after }) => gateway(`/v1/characters/${encodeURIComponent(id)}/mentions?actorDiscordId=${actor}${after ? `&after=${after}` : ''}`)));
}
