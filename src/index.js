import mongoose from 'mongoose';
import { config } from './config.js';
import { createApp } from './app.js';

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
console.log('[server] connected to MongoDB');

const app = createApp();
const server = app.listen(config.port, () => console.log(`[server] http://localhost:${config.port}`));

const stop = async (signal) => {
  console.log(`[server] ${signal}: shutting down`);
  server.close();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
