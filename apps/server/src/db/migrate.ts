import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from './client.js';
import { nowSec } from '../util/time.js';
import { logger } from '../util/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

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
      ).run(name, nowSec());
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
