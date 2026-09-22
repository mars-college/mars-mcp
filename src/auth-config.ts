import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthConfig } from './auth-types.js';

export function loadAuthConfig(publicUrl: string): AuthConfig {
  const url = new URL(publicUrl);
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_URL must be an HTTPS origin (local HTTP issuer must use localhost or 127.0.0.1)');
  }
  const roleMap: unknown = JSON.parse(process.env.DISCORD_ROLE_MAP || '{}');
  if (!roleMap || typeof roleMap !== 'object' || Array.isArray(roleMap)
      || Object.entries(roleMap).some(([id, role]) => !/^\d+$/.test(id)
        || typeof role !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(role)
        || role === 'member' || role === 'public')) {
    throw new Error('DISCORD_ROLE_MAP must map numeric Discord role IDs to non-reserved community role names');
  }
  const ttl = Number(process.env.AUTH_SESSION_TTL || '900');
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) {
    throw new Error('AUTH_SESSION_TTL must be 60..900 seconds');
  }
  return {
    issuer: url.origin,
    resource: new URL('/mcp', url).href,
    databasePath: process.env.AUTH_DATABASE_PATH || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'mars-mcp', 'auth.sqlite'),
    discordClientId: process.env.DISCORD_CLIENT_ID || '',
    discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    discordGuildId: process.env.DISCORD_GUILD_ID || '',
    roleMap: roleMap as Record<string, string>,
    sessionTtl: ttl,
  };
}

export function discordConfigured(config: AuthConfig): boolean {
  return Boolean(config.discordClientId && config.discordClientSecret && config.discordGuildId);
}
