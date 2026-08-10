import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from './client.js';
import { nowMs } from '../util/time.js';
import { logger } from '../util/logger.js';
import { INTEL_DEFAULTS } from '../collectors/intel-settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SEED_DIR = path.join(__dirname, '..', 'seed');

function ensureTable(): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations_applied (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// ── seed data (idempotent — INSERT OR IGNORE / row-exists checks) ───────

interface SeedAsset {
  symbol: string;
  display_name: string;
}

/**
 * Default settings rows (PLAN §7, §9, §10). All values are data, not code —
 * editable at runtime via the settings API. Provider limits drift; verify
 * at setup (PLAN §16.4).
 */
const DEFAULT_SETTINGS: Record<string, unknown> = {
  'guards.defaults': {
    min_confidence: 65,
    cooldown_min: 30,
    min_hold_min: 60,
    max_trades_day: 6,
    max_pos_pct: 30,
    min_notional_usd: 10,
    default_sl_pct: -5,
    default_tp_pct: 10,
    sl_clamp_pct: [-15, -1],
    tp_clamp_pct: [2, 50],
    drawdown_kill_pct: 50,
    fee_pct_per_side: 0.1,
    slippage_pct: 0.05,
  },
  'triggers.thresholds': {
    price_velocity_atr_mult: 2,
    rsi_low: 30,
    rsi_high: 70,
    bb_period: 20,
    bb_stddev: 2,
    volume_spike_mult: 3,
    funding_flip: true,
    per_trigger_symbol_cooldown_min: 15,
    per_bot_wake_floor_min: 10,
    p1_reserve_pct: 30,
    p2_pool_min_pct: 50,
  },
  // IMPL-3a intel collectors + their indicator vote thresholds. Shape and
  // defaults live in collectors/intel-settings.ts; this row only seeds them.
  'intel.thresholds': INTEL_DEFAULTS,
  'providers.registry': [
    { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat-v3-0324:free'], rpm: 20, rpd: 50, enabled: true },
    { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'], rpm: 30, rpd: 1000, enabled: true },
    { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-flash-lite'], rpm: 15, rpd: 1000, enabled: true },
    { id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-small-latest'], rpm: 60, rpd: 500, enabled: true },
    { id: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b'], rpm: 30, rpd: 1000, enabled: true },
    { id: 'ollama', baseUrl: 'http://localhost:11434/v1', models: [], rpm: 600, rpd: 100000, enabled: false },
  ],
};

export function seedDefaults(): void {
  // 1. Watchlist assets (7 defaults; skipped once the user edits the list).
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM assets').get() as {
    count: number;
  };
  if (count === 0) {
    const raw = fs.readFileSync(path.join(SEED_DIR, 'crypto_watchlist.json'), 'utf8');
    const seedAssets = JSON.parse(raw) as SeedAsset[];
    const insert = db.prepare(
      'INSERT OR IGNORE INTO assets (symbol, display_name, active, added_ts) VALUES (?, ?, 1, ?)',
    );
    const ts = nowMs();
    const tx = db.transaction((rows: SeedAsset[]) => {
      for (const r of rows) insert.run(r.symbol, r.display_name, ts);
    });
    tx(seedAssets);
    logger.info({ inserted: seedAssets.length }, 'seed watchlist loaded');
  }

  // 2. Default settings rows — never overwrite user edits.
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, JSON.stringify(value));
  }
}

export function runMigrations(): { applied: string[]; skipped: string[] } {
  ensureTable();
  const all = listMigrationFiles();
  const alreadyRows = db
    .prepare('SELECT name FROM migrations_applied')
    .all() as Array<{ name: string }>;
  const already = new Set(alreadyRows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of all) {
    if (already.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO migrations_applied (name, applied_at) VALUES (?, ?)',
      ).run(name, nowMs());
    });
    try {
      tx();
      applied.push(name);
      logger.info({ migration: name }, 'migration applied');
    } catch (err) {
      logger.error({ migration: name, err }, 'migration failed');
      throw err;
    }
  }

  seedDefaults();

  return { applied, skipped };
}

// CLI entry: `pnpm migrate` / `tsx src/db/migrate.ts`
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = runMigrations();
  logger.info(
    { applied: result.applied.length, skipped: result.skipped.length },
    'migrations complete',
  );
  process.exit(0);
}
