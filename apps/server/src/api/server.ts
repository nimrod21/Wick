import Fastify from 'fastify';
import cors from '@fastify/cors';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import { registerSseRoutes } from './sse.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAssetsRoutes } from './assets.js';
import { registerCandlesRoutes } from './candles.js';
import { registerMarketRoutes } from './market.js';
import { registerBotsReadRoutes } from './bots-read.js';
import { registerBotsRoutes } from './bots.js';

export async function buildServer() {
  const app = Fastify({
    logger: logger as unknown as import('fastify').FastifyBaseLogger,
    disableRequestLogging: false,
  });

  await app.register(cors, {
    origin: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    credentials: false,
  });
  await app.register(FastifySSEPlugin);

  app.get('/health', async () => ({ ok: true, ts: nowSec() }));

  await app.register(registerSseRoutes);
  await app.register(registerSettingsRoutes, { prefix: '/api/settings' });
  await app.register(registerAssetsRoutes, { prefix: '/api/assets' });
  await app.register(registerCandlesRoutes, { prefix: '/api/market/candles' });
  await app.register(registerMarketRoutes, { prefix: '/api/market' });
  await app.register(registerBotsReadRoutes, { prefix: '/api/bots' });
  await app.register(registerBotsRoutes, { prefix: '/api/bots' });
  // Phase 5 registers learning routes here (stats, outcomes, journal).

  return app;
}
