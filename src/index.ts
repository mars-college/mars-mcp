import { createApp } from './app.js';
import { loadAuthConfig, discordConfigured } from './auth-config.js';

const host = process.env.BIND_HOST?.trim() || '127.0.0.1';
const portValue = process.env.PORT?.trim() || '4400';
if (!/^[1-9]\d*$/.test(portValue) || Number(portValue) > 65535) {
  throw new Error('PORT must be decimal digits in the range 1-65535');
}
const port = Number(portValue);
const config = loadAuthConfig(process.env.PUBLIC_URL?.trim() || `http://localhost:${port}`);
const { app, store } = createApp(config);
if (!discordConfigured(config)) console.warn('[mars-mcp] Discord authentication is not configured; new logins are disabled');
const server = app.listen(port, host, () => {
  console.log(`[mars-mcp] listening on http://${host}:${port}`);
  console.log(`[mars-mcp] issuer ${config.issuer}`);
});
server.on('error', () => {
  console.error('[mars-mcp] listen failed');
  store.close();
  process.exit(1);
});
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[mars-mcp] ${signal} received, shutting down`);
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
