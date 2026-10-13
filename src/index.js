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

const stop = async (signal) => {
  console.log(`[server] ${signal}: shutting down`);
  closeSockets();
  server.close();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
