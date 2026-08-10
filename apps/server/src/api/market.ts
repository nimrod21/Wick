/**
 * Market API — indicator sets and the dashboard summary strip.
 *
 *   GET /api/market/indicators?symbol&tf   latest indicator set with votes
 *   GET /api/market/summary                all active symbols: last price,
 *                                          24h change, latest votes
 *
 * (/api/market/candles is registered from api/candles.ts.)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { getLastPrice, getTickerStats } from '../collectors/crypto/binance-ws.js';
import { INDICATOR_TF } from '../market/indicator-engine.js';
import { isMarketWarm } from '../market/market-state.js';

const indicatorsQuerySchema = z.object({
  symbol: z.string().min(1),
  tf: z.string().min(1).default(INDICATOR_TF),
});

interface IndicatorRow {
  name: string;
  ts: number;
  value: number | null;
  vote: string | null;
}

function latestIndicatorSet(symbol: string, tf: string): IndicatorRow[] {
  return db
    .prepare(
      `SELECT name, ts, value, vote FROM indicator_values
        WHERE symbol = ? AND tf = ?
          AND ts = (SELECT MAX(ts) FROM indicator_values WHERE symbol = ? AND tf = ?)
        ORDER BY name`,
    )
    .all(symbol, tf, symbol, tf) as IndicatorRow[];
}

export async function registerMarketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/indicators', async (req, reply) => {
    const parsed = indicatorsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const symbol = parsed.data.symbol.toUpperCase();
    const tf = parsed.data.tf;
    const rows = latestIndicatorSet(symbol, tf);
    return {
      symbol,
      tf,
      ts: rows[0]?.ts ?? null,
      indicators: rows.map((r) => ({ name: r.name, value: r.value, vote: r.vote })),
    };
  });

  app.get('/summary', async () => {
    const assets = db
      .prepare(`SELECT symbol, display_name FROM assets WHERE active = 1 ORDER BY symbol`)
      .all() as Array<{ symbol: string; display_name: string }>;

    const symbols = assets.map((a) => {
      const stats = getTickerStats(a.symbol);
      let lastPrice = stats?.lastPrice ?? getLastPrice(a.symbol);
      let changePct24h = stats?.changePct24h ?? null;

      // Fallbacks before the first WS frame: freshest 1m close, and 24h change
      // from the candle store.
      if (lastPrice === null || changePct24h === null) {
        const last1m = db
          .prepare(
            `SELECT c, ts FROM candles WHERE symbol = ? AND tf = '1m' ORDER BY ts DESC LIMIT 1`,
          )
          .get(a.symbol) as { c: number; ts: number } | undefined;
        if (last1m) {
          if (lastPrice === null) lastPrice = last1m.c;
          if (changePct24h === null) {
            const ago = db
              .prepare(
                `SELECT c FROM candles WHERE symbol = ? AND tf = '1h' AND ts <= ? ORDER BY ts DESC LIMIT 1`,
              )
              .get(a.symbol, last1m.ts - 24 * 3_600_000) as { c: number } | undefined;
            if (ago && ago.c > 0) changePct24h = ((last1m.c - ago.c) / ago.c) * 100;
          }
        }
      }

      const votes: Record<string, string | null> = {};
      for (const r of latestIndicatorSet(a.symbol, INDICATOR_TF)) {
        votes[r.name] = r.vote;
      }

      return {
        symbol: a.symbol,
        displayName: a.display_name,
        lastPrice,
        changePct24h,
        // Asset-context header on the dashboard (IMPL-6C). Straight off the
        // @miniTicker cache — null until the first frame, never back-filled
        // from candles (a 24h window stitched from stored bars would disagree
        // with the exchange's own rolling window).
        high24h: stats?.high24h ?? null,
        low24h: stats?.low24h ?? null,
        volume24h: stats?.volume24h ?? null,
        votes,
      };
    });

    return { warm: isMarketWarm(), symbols };
  });
}
