import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Event, EventKind } from '@cockpit/shared';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';

const VALID_KINDS: readonly EventKind[] = [
  'candle',
  'whale_tx',
  'news',
  'indicator',
  'alert',
  'trade_tick',
  'orderbook',
  'probability',
];

const querySchema = z.object({
  topics: z.string().optional(),
  assetIds: z.string().optional(),
});

function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function parseIdList(raw: string | undefined): Set<number> | null {
  const parts = parseList(raw);
  if (!parts) return null;
  const ids = new Set<number>();
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n)) ids.add(n);
  }
  return ids.size ? ids : null;
}

export async function registerSseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stream', async (request: FastifyRequest, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
      return;
    }

    const topicList = parseList(parsed.data.topics);
    const topicFilter: Set<EventKind> | null = topicList
      ? new Set(
          topicList.filter((t): t is EventKind =>
            (VALID_KINDS as readonly string[]).includes(t),
          ),
        )
      : null;
    const idFilter = parseIdList(parsed.data.assetIds);

    const queue: Array<{ id: string; event: string; data: string }> = [];
    let closed = false;
    let notify: (() => void) | null = null;

    function enqueue(frame: { id: string; event: string; data: string }): void {
      queue.push(frame);
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    }

    const unsubscribe = eventBus.onAny((event: Event) => {
      if (closed) return;
      if (topicFilter && !topicFilter.has(event.kind)) return;
      if (idFilter) {
        const maybeAssetId = (event as { assetId?: number }).assetId;
        if (typeof maybeAssetId !== 'number' || !idFilter.has(maybeAssetId)) {
          return;
        }
      }
      enqueue({
        id: String(event.id),
        event: event.kind,
        data: JSON.stringify(event),
      });
    });

    const heartbeat = setInterval(() => {
      if (closed) return;
      enqueue({
        id: `hb-${Date.now()}`,
        event: 'ping',
        data: JSON.stringify({ ts: Math.floor(Date.now() / 1000) }),
      });
    }, 15_000);

    request.raw.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
      logger.debug({ topics: topicList, ids: idFilter && [...idFilter] }, 'sse client closed');
    });

    async function* stream(): AsyncGenerator<
      { id: string; event: string; data: string },
      void,
      unknown
    > {
      // initial hello frame so the client knows the connection is live
      yield {
        id: `hello-${Date.now()}`,
        event: 'hello',
        data: JSON.stringify({
          ts: Math.floor(Date.now() / 1000),
          topics: topicList,
          assetIds: idFilter ? [...idFilter] : null,
        }),
      };
      while (!closed) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    }

    reply.sse(stream());
  });
}
