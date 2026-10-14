import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';
import { attachSockets, closeSockets } from './live/socket.js';
import { ensureAdmin } from './admin-bootstrap.js';

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
console.log('[server] connected to MongoDB');
await ensureAdmin();

const app = createApp();
const server = createServer(app);
await attachSockets(server); // live games and notifications share the HTTP port
server.listen(config.port, () => console.log(`[server] http://localhost:${config.port}`));

/*
 * Keep-awake: Render's free plan puts a service to sleep after 15 minutes without incoming requests.
 * Every 14 minutes the server calls its own /api/health through its public address, which counts as
 * an incoming request, so it never goes idle long enough to sleep.
 *
 * The public address comes from RENDER_EXTERNAL_URL (Render sets it automatically) or KEEP_AWAKE_URL.
 * Set KEEP_AWAKE=false to turn it off; KEEP_AWAKE_MINUTES changes the interval (default 14).
 * It only runs in production, or when KEEP_AWAKE_URL is set explicitly.
 */
const keepAwakeUrl = (process.env.KEEP_AWAKE_URL || (config.production ? process.env.RENDER_EXTERNAL_URL : '') || '').replace(/\/+$/, '');
const keepAwakeMinutes = Number(process.env.KEEP_AWAKE_MINUTES) || 14;
let keepAwake = null;
if (keepAwakeUrl && process.env.KEEP_AWAKE !== 'false') {
  const ping = async () => {
    try {
      const res = await fetch(`${keepAwakeUrl}/api/health`, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'rank-and-file-keep-awake' } });
      if (!res.ok) console.warn(`[keep-awake] health check answered ${res.status}`);
    } catch (e) {
      console.warn(`[keep-awake] health check failed: ${e.message}`);
    }
  };
  keepAwake = setInterval(ping, keepAwakeMinutes * 60_000);
  console.log(`[keep-awake] pinging ${keepAwakeUrl}/api/health every ${keepAwakeMinutes} min`);
}

const stop = async (signal) => {
  console.log(`[server] ${signal}: shutting down`);
  clearInterval(keepAwake);
  closeSockets();
  server.close();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
