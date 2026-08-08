/**
 * Paper-engine dev CLI (IMPL-2 §2.4) — the Phase 2 test harness.
 *
 *   pnpm paper buy  BTCUSDT 100 --sl 5 --tp 10   # $100 notional, SL 5% below, TP 10% above
 *   pnpm paper sell BTCUSDT 100                  # sell 100% of position
 *   pnpm paper status [botId]
 *   pnpm paper snapshot                          # force an equity snapshot row (all bots)
 *
 * Design choice: the CLI talks to the live server DB DIRECTLY (same
 * better-sqlite3 file, WAL handles the two processes) by importing the
 * engine — it does not boot the server stack and does not call the HTTP
 * API. Since this process has no Binance WS, it fetches a live price from
 * Binance REST (api/v3/ticker/price) before each trade and primes the
 * engine's price chain (`primeMid`); if REST fails it falls back to the
 * newest 1m candle the running server wrote. Guards are NOT applied here
 * on purpose — this harness must be able to set e.g. a 0.1% SL to test
 * the protector, which the guard clamp would forbid.
 *
 * A bot named 'test-bot' ($1000 bankroll, status running) is seeded on
 * first use when --bot is not given.
 */

import { db } from '../apps/server/src/db/client.js';
import { runMigrations } from '../apps/server/src/db/migrate.js';
import {
  buy,
  sell,
  equity,
  getDrawdown,
  getPositions,
  midPrice,
  primeMid,
  snapshotEquityAll,
  type BotRow,
  type TradeResult,
} from '../apps/server/src/paper/engine.js';
import { nowMs } from '../apps/server/src/util/time.js';

const TEST_BOT_NAME = 'test-bot';
const TEST_BANKROLL = 1000;

// ── arg parsing ────────────────────────────────────────────────────────

interface Flags {
  [k: string]: number;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) fail(`flag ${a} needs a numeric value`);
      flags[a.slice(2)] = v;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(msg: string): never {
  console.error(`paper: ${msg}`);
  process.exit(1);
}

// ── bot seeding ────────────────────────────────────────────────────────

function seedTestBot(): BotRow {
  const existing = db
    .prepare('SELECT * FROM bots WHERE name = ?')
    .get(TEST_BOT_NAME) as BotRow | undefined;
  if (existing) return existing;
  const config = {
    cadence_tf: '1h',
    symbols: ['BTCUSDT'],
    personality: 'dev test harness bot',
  };
  const info = db
    .prepare(
      `INSERT INTO bots (name, status, bankroll_start, cash, config_json, created_ts)
       VALUES (?, 'running', ?, ?, ?, ?)`,
    )
    .run(TEST_BOT_NAME, TEST_BANKROLL, TEST_BANKROLL, JSON.stringify(config), nowMs());
  const bot = db
    .prepare('SELECT * FROM bots WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as BotRow;
  console.log(`seeded ${TEST_BOT_NAME} (id ${bot.id}) with $${TEST_BANKROLL}`);
  return bot;
}

function resolveBot(flags: Flags): BotRow {
  if (flags.bot !== undefined) {
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(flags.bot) as BotRow | undefined;
    if (!bot) fail(`bot ${flags.bot} not found`);
    return bot;
  }
  return seedTestBot();
}

// ── live price priming ─────────────────────────────────────────────────

async function primeLivePrice(symbol: string): Promise<void> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = (await res.json()) as { price: string };
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`bad price ${body.price}`);
    primeMid(symbol, price);
    console.log(`live REST price ${symbol} = ${price}`);
  } catch (err) {
    console.warn(
      `REST price fetch failed (${(err as Error).message}) — falling back to newest 1m candle`,
    );
  }
}

// ── output helpers ─────────────────────────────────────────────────────

function printResult(res: TradeResult, bot: BotRow): void {
  if (!res.ok) {
    console.error(`REJECTED: ${res.reason}${res.detail ? ` (${res.detail})` : ''}`);
    process.exit(2);
  }
  const f = res.fill;
  console.log(
    `${f.side.toUpperCase()} ${f.symbol}: qty=${f.qty} price=${f.price} fee=$${f.fee.toFixed(4)} slip=$${f.slip.toFixed(4)}`,
  );
  if (res.position) {
    const p = res.position;
    console.log(
      `position: qty=${p.qty} avg_entry=${p.avg_entry} stop=${p.stop_price} tp=${p.tp_price}`,
    );
  } else {
    console.log('position: closed');
  }
  console.log(`cash: $${res.cash.toFixed(6)}  equity: $${(equity(bot.id) ?? NaN).toFixed(6)}`);
}

function printStatus(bot: BotRow): void {
  const dd = getDrawdown(bot.id);
  console.log(`bot ${bot.id} '${bot.name}' [${bot.status}] bankroll=$${bot.bankroll_start}`);
  console.log(
    `cash=$${bot.cash.toFixed(6)} equity=$${dd ? dd.equity.toFixed(6) : '?'} hwm=$${dd ? dd.highWaterMark.toFixed(2) : '?'} drawdown=${dd ? dd.drawdownPct.toFixed(3) : '?'}%`,
  );
  const positions = getPositions(bot.id);
  if (positions.length === 0) console.log('positions: none');
  for (const p of positions) {
    const mid = midPrice(p.symbol);
    const value = mid !== null ? p.qty * mid : null;
    const upnl = mid !== null ? (mid - p.avg_entry) * p.qty : null;
    console.log(
      `  ${p.symbol}: qty=${p.qty} avg=${p.avg_entry} stop=${p.stop_price} tp=${p.tp_price}` +
        ` mid=${mid} value=$${value?.toFixed(2) ?? '?'} uPnL=$${upnl?.toFixed(4) ?? '?'}`,
    );
  }
  const fills = db
    .prepare('SELECT * FROM fills WHERE bot_id = ? ORDER BY ts DESC LIMIT 5')
    .all(bot.id) as Array<Record<string, unknown>>;
  console.log(`last fills (${fills.length}):`);
  for (const f of fills) {
    console.log(
      `  #${f.id} ${f.side} ${f.symbol} qty=${f.qty} price=${f.price} fee=${f.fee} slip=${f.slip} decision=${f.decision_id} ts=${f.ts}`,
    );
  }
  const snaps = db
    .prepare(
      'SELECT COUNT(*) AS n, MAX(ts) AS latest FROM equity_snapshots WHERE bot_id = ?',
    )
    .get(bot.id) as { n: number; latest: number | null };
  console.log(`equity snapshots: ${snaps.n}${snaps.latest ? ` (latest ${new Date(snaps.latest).toISOString()})` : ''}`);
}

// ── main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  runMigrations(); // no-op on a live DB; makes the CLI standalone-safe
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'buy': {
      const [symbol, notionalRaw] = positional;
      const notional = Number(notionalRaw);
      if (!symbol || !Number.isFinite(notional)) fail('usage: paper buy <SYMBOL> <notionalUsd> [--sl N] [--tp N] [--bot id]');
      const bot = resolveBot(flags);
      await primeLivePrice(symbol);
      printResult(
        buy(bot.id, symbol, notional, { slPct: flags.sl ?? null, tpPct: flags.tp ?? null }),
        bot,
      );
      break;
    }
    case 'sell': {
      const [symbol, pctRaw] = positional;
      const pct = Number(pctRaw ?? 100);
      if (!symbol || !Number.isFinite(pct)) fail('usage: paper sell <SYMBOL> <pctOfPosition> [--bot id]');
      const bot = resolveBot(flags);
      await primeLivePrice(symbol);
      printResult(sell(bot.id, symbol, pct), bot);
      break;
    }
    case 'status': {
      const bot =
        positional[0] !== undefined
          ? resolveBot({ bot: Number(positional[0]) })
          : resolveBot(flags);
      for (const p of getPositions(bot.id)) await primeLivePrice(p.symbol);
      printStatus(bot);
      break;
    }
    case 'snapshot': {
      resolveBot(flags);
      const n = snapshotEquityAll();
      console.log(`wrote ${n} equity snapshot(s)`);
      break;
    }
    default:
      fail(`unknown command '${cmd ?? ''}' — commands: buy, sell, status, snapshot`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
