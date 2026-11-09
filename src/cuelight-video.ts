import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DURATION = 900;
type Request = (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<unknown>;
export interface VideoOptions { ytDlpPath?: string; ffmpegPath?: string; videoScratchDir?: string }
const mediaSchema = z.object({ id: z.string(), kind: z.enum(['file', 'web']), tags: z.array(z.string()).optional(),
  artifact: z.object({ digest: z.string() }).passthrough().optional() }).passthrough();
type Media = z.infer<typeof mediaSchema>;
const runFile = promisify(execFile);
async function extract(binary: string, args: string[], timeout: number): Promise<string> {
  try { return (await runFile(binary, args, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch (error) {
    const detail = error as { stderr?: string; killed?: boolean };
    if (detail.stderr?.includes('Unsupported URL:')) throw new Error('Unsupported video URL');
    throw new Error(`Video extractor failed${detail.killed ? ' (timeout)' : ''}; source may be unavailable or require authentication`);
  }
}
export async function videoMedia(url: string, options: VideoOptions, upstream: Request, send: typeof fetch, base?: string, token?: string): Promise<Media> {
  if (!options.ytDlpPath || !options.videoScratchDir) throw new Error('Video importer is not configured');
  const deadline = Date.now() + 210000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Video import exceeded 210 second deadline');
    return Math.min(ms, 15000);
  };
  const request: Request = (...args) => { remaining(); return upstream(...args); };
  const tag = `mars-source:${createHash('sha256').update(url).digest('hex')}`;
  const existing: Media[] = [];
  let cursor: string | undefined;
  do {
    const page = z.object({ items: z.array(mediaSchema), page: z.object({ nextCursor: z.string().nullish() }).optional() })
      .parse(await request(`/media?kind=file&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    existing.push(...page.items);
    cursor = page.page?.nextCursor ?? undefined;
  } while (cursor);
  const reused = existing.find(media => media.tags?.includes(tag));
  if (reused) return reused;
  const common = ['--ignore-config', '--no-playlist', '--no-warnings', '--socket-timeout', '15', '--retries', '1',
    '-f', 'bv[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a][height<=720]'];
  let metadata: { duration?: number | null; is_live?: boolean; title?: string; filesize?: number | null; filesize_approx?: number | null };
  try {
    metadata = z.object({ duration: z.number().nullish(), is_live: z.boolean().optional(), title: z.string().optional(),
      filesize: z.number().nullish(), filesize_approx: z.number().nullish() }).parse(JSON.parse(
        await extract(options.ytDlpPath, [...common, '--dump-single-json', '--skip-download', '--', url], 30000)));
  } catch (error) {
    if (error instanceof Error && error.message === 'Unsupported video URL') return mediaSchema.parse(await request('/media', 'POST', { kind: 'web', url, title: `Mars · ${url}` }));
    throw error;
  }
  if (metadata.is_live || !metadata.duration || metadata.duration > MAX_DURATION) throw new Error('Video duration exceeds 900 seconds, is unknown, or is live');
  if ((metadata.filesize ?? metadata.filesize_approx ?? 0) > MAX_BYTES) throw new Error('Video size exceeds 256 MiB');
  await mkdir(options.videoScratchDir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(options.videoScratchDir, 'video-'));
  try {
    const file = join(scratch, 'video.mp4');
    await extract(options.ytDlpPath, [...common, '--ffmpeg-location', options.ffmpegPath ?? 'ffmpeg',
      '--merge-output-format', 'mp4', '--max-filesize', String(MAX_BYTES),
      '--match-filter', `duration <= ${MAX_DURATION} & !is_live`, '-o', file, '--', url], 120000);
    const size = (await stat(file).catch(() => { throw new Error('Video size limit prevented download or extractor produced no MP4'); })).size;
    if (size > MAX_BYTES || size === 0) throw new Error('Video size exceeds 256 MiB or file is empty');
    const handle = await open(file, 'r');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    const digest = hash.digest('hex');
    const same = existing.find(media => media.artifact?.digest === digest);
    if (same) return same;
    const upload = z.object({ id: z.string() }).parse(await request('/uploads', 'POST', { name: 'mars-video.mp4', length: size, mediaType: 'video/mp4' }, { 'Idempotency-Key': randomUUID() }));
    const input = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new Error('Video upload could not read file');
        const response = await send(`${base!.replace(/\/$/, '')}/api/v1/uploads/${encodeURIComponent(upload.id)}`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
          body: new Uint8Array(buffer.subarray(0, bytesRead)), signal: AbortSignal.timeout(remaining()),
        });
        if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
        offset += bytesRead;
      }
    } finally { await input.close(); }
    const asset = z.object({ id: z.string() }).parse(await request(`/uploads/${encodeURIComponent(upload.id)}/complete`, 'POST', undefined, { 'Idempotency-Key': randomUUID() }));
    return mediaSchema.parse(await request('/media', 'POST', { kind: 'file', assetId: asset.id,
      title: (metadata.title ?? 'Mars video').slice(0, 255), description: url, tags: [tag],
      playback: { fit: 'fit', loop: true, muted: true, volume: 0, orientation: 0 },
    }, { 'Idempotency-Key': `mars-video-${digest}` }));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
