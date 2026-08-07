/**
 * SSE stream at /api/sse. Emits every bus event kind (tick, candle,
 * indicator, funding, fear_greed, market_warm, ...) as its own SSE event
 * name. Ticks are throttled to ≤2/s per symbol per connection; all other
 * kinds pass through unthrottled.
 *
 * Query params: ?topics=tick,candle&symbols=BTCUSDT,ETHUSDT (both optional).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VALID_EVENT_KINDS, type Event, type EventKind } from '@wick/shared';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';

const TICK_MIN_INTERVAL_MS = 500; // ≤2 ticks/s per symbol

const querySchema = z.object({
  topics: z.string().optional(),
  symbols: z.string().optional(),
});

function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

export async function registerSseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sse', async (request: FastifyRequest, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
      return;
    }

    const topicList = parseList(parsed.data.topics);
    const topicFilter: Set<EventKind> | null = topicList
      ? new Set(
          topicList.filter((t): t is EventKind =>
            (VALID_EVENT_KINDS as readonly string[]).includes(t),
          ),
        )
      : null;
    const symbolList = parseList(parsed.data.symbols);
    const symbolFilter: Set<string> | null = symbolList
      ? new Set(symbolList.map((s) => s.toUpperCase()))
      : null;

    const queue: Array<{ id: string; event: string; data: string }> = [];
    let closed = false;
    let notify: (() => void) | null = null;
    const lastTickSentAt = new Map<string, number>();

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
      if (symbolFilter) {
        const maybeSymbol = (event as { symbol?: string }).symbol;
        if (typeof maybeSymbol !== 'string' || !symbolFilter.has(maybeSymbol)) {
          return;
        }
      }
      if (event.kind === 'tick') {
        const now = Date.now();
        const last = lastTickSentAt.get(event.symbol) ?? 0;
        if (now - last < TICK_MIN_INTERVAL_MS) return;
        lastTickSentAt.set(event.symbol, now);
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
        data: JSON.stringify({ ts: Date.now() }),
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
      logger.debug({ topics: topicList, symbols: symbolList }, 'sse client closed');
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
          ts: Date.now(),
          topics: topicList,
          symbols: symbolList,
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
