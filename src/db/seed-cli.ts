#!/usr/bin/env node
/**
 * Creates (or recreates) the synthetic portfolio database.
 *
 *   npm run seed                       # writes DB_PATH (default <project>/data/portfolio.db)
 *   npm run seed:demo                  # pinned to 2026-10-31: matches the numbers in README.md
 *   SEED_AS_OF=2026-10-31 npm run seed # same, via the environment
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_DB_PATH, loadDotEnv } from '../config.js';
import { createLogger } from '../logger.js';
import { seedDatabase } from './seed.js';

loadDotEnv();
const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const dbPath = resolve(process.env.DB_PATH ?? DEFAULT_DB_PATH);
// --as-of=YYYY-MM-DD (used by `npm run seed:demo`) wins over SEED_AS_OF.
const asOfFlag = process.argv.find((a) => a.startsWith('--as-of='))?.slice('--as-of='.length);
const asOfDate = asOfFlag ?? process.env.SEED_AS_OF;
if (asOfDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
  logger.fatal({ asOfDate }, 'The as-of date must be YYYY-MM-DD');
  process.exit(1);
}
const seed = Number(process.env.SEED ?? 42);

mkdirSync(dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
try {
  const stats = seedDatabase(db, { seed, ...(asOfDate ? { asOfDate } : {}) });
  logger.info({ dbPath, ...stats }, 'Synthetic portfolio database created');
} finally {
  db.close();
}
