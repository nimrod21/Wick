import Fastify from 'fastify';
import cors from '@fastify/cors';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { logger } from '../util/logger.js';
import { registerHealthRoutes } from './health.js';
import { registerSseRoutes } from './sse.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAssetsRoutes } from './assets.js';
import { registerCandlesRoutes } from './candles.js';
import { registerMarketRoutes } from './market.js';
import { registerBotsReadRoutes } from './bots-read.js';
import { registerBotsRoutes } from './bots.js';
import { registerTradeRoutes } from './trade.js';
import { registerLearnBotRoutes, registerStatsRoutes } from './learn.js';
import { registerProvidersRoutes } from './providers.js';
import { registerIntelRoutes, registerNotificationsRoutes } from './intel.js';

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

  await app.register(registerHealthRoutes);
  await app.register(registerSseRoutes);
  await app.register(registerSettingsRoutes, { prefix: '/api/settings' });
  await app.register(registerAssetsRoutes, { prefix: '/api/assets' });
  await app.register(registerCandlesRoutes, { prefix: '/api/market/candles' });
  await app.register(registerMarketRoutes, { prefix: '/api/market' });
  await app.register(registerBotsReadRoutes, { prefix: '/api/bots' });
  await app.register(registerBotsRoutes, { prefix: '/api/bots' });
  // IMPL-4 manual trading (human account, same paper engine).
  await app.register(registerTradeRoutes, { prefix: '/api/trade' });
  // Phase 5 learning routes.
  await app.register(registerLearnBotRoutes, { prefix: '/api/bots' });
  await app.register(registerStatsRoutes, { prefix: '/api/stats' });
  // Phase 6 UI routes.
  await app.register(registerProvidersRoutes, { prefix: '/api/providers' });
  // IMPL-3b intel page + notification bell.
  await app.register(registerIntelRoutes, { prefix: '/api/intel' });
  await app.register(registerNotificationsRoutes, { prefix: '/api/notifications' });

  return app;
}
