import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { errorHandler, jsonOnly } from './middleware/http.js';
import authRoutes from './routes/auth.js';
import syncRoutes from './routes/sync.js';
import accountRoutes from './routes/account.js';
import dashboardRoutes from './routes/dashboard.js';
import userRoutes from './routes/users.js';
import challengeRoutes from './routes/challenges.js';
import matchRoutes from './routes/matches.js';
import adminRoutes from './routes/admin.js';

export function createApp({ staticDir = config.staticDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Stockfish is WebAssembly; the asm.js fallback runs in a worker
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          workerSrc: ["'self'", 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'data:', 'blob:'],
          // live lichess puzzles and game import from chess.com / lichess
          connectSrc: ["'self'", 'https://lichess.org', 'https://*.lichess.org', 'https://api.chess.com', ...config.clientOrigins],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
    }),
  );
  if (config.clientOrigins.length) app.use('/api', cors({ origin: config.clientOrigins, credentials: true }));
  app.use(compression());
  app.use(cookieParser());
  if (!staticDir) app.get('/', (req, res) => res.json({ ok: true, service: 'rank-and-file', api: '/api' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', jsonOnly);
  app.use('/api', (req, res, next) => (res.set('Cache-Control', 'no-store'), next()));

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'rank-and-file' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/account', accountRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/challenges', challengeRoutes);
  app.use('/api/matches', matchRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'No such API route.' }));

  // The built React app (npm run build in the project root), so one server hosts everything.
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(join(staticDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
