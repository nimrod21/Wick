import Fastify from 'fastify';
import cors from '@fastify/cors';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import { registerSseRoutes } from './sse.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAssetsRoutes } from './assets.js';
import { registerCandlesRoutes } from './candles.js';
import { registerEventsRoutes } from './events.js';
import { registerOrdersRoutes } from './orders.js';
import { registerPositionsRoutes } from './positions.js';
import { registerWhalesRoutes } from './whales.js';
import { registerIndicatorsRoutes } from './indicators.js';
import { registerNewsRoutes } from './news.js';
import { registerAlertsRoutes } from './alerts.js';
import { registerProbabilityRoutes } from './probability.js';
import { registerRuntimeRoutes } from './runtime.js';

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
  await app.register(registerCandlesRoutes, { prefix: '/api/candles' });
  await app.register(registerEventsRoutes, { prefix: '/api/events' });
  await app.register(registerOrdersRoutes, { prefix: '/api/orders' });
  await app.register(registerPositionsRoutes, { prefix: '/api/positions' });
  await app.register(registerWhalesRoutes, { prefix: '/api/whales' });
  await app.register(registerIndicatorsRoutes, { prefix: '/api/indicators' });
  await app.register(registerNewsRoutes, { prefix: '/api/news' });
  await app.register(registerAlertsRoutes, { prefix: '/api/alerts' });
  await app.register(registerProbabilityRoutes, { prefix: '/api/probability' });
  await app.register(registerRuntimeRoutes, { prefix: '/api/runtime' });

  return app;
}
