import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve DB path relative to this file, NOT process.cwd().
// From dist/db/client.js or src/db/client.ts, two `..` = apps/server root.
const thisFile = fileURLToPath(import.meta.url);
const serverRoot = path.resolve(path.dirname(thisFile), '..', '..');
const dataDir = path.join(serverRoot, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'wick.db');

export const db: DatabaseType = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const DB_PATH = dbPath;
