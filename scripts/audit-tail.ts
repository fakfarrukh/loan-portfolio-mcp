/**
 * Prints the most recent audit records as a table. Read-only; useful for demos and debugging.
 *
 *   npm run audit:tail            # last 15 records
 *   npm run audit:tail -- --n=50
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_AUDIT_DB_PATH, loadDotEnv } from '../src/config.js';

loadDotEnv();
const path = resolve(process.env.AUDIT_DB_PATH ?? DEFAULT_AUDIT_DB_PATH);
const nFlag = process.argv.find((a) => a.startsWith('--n='));
const n = Math.min(Math.max(1, Number(nFlag?.slice(4) ?? 15) || 15), 500);

if (!existsSync(path)) {
  console.error(`No audit database at ${path} yet. Make a tool call first.`);
  process.exit(1);
}

const db = new Database(path, { readonly: true });
const columns = (db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map(
  (c) => c.name,
);
if (!columns.includes('kind')) {
  console.error('This audit database uses the v1.0 layout. Start the server once to upgrade it.');
  process.exit(1);
}
const rows = db
  .prepare(
    `SELECT substr(ts, 12, 8) AS time, subject, role, kind, name, outcome,
            COALESCE(error_code, '') AS error, row_count AS rows, duration_ms AS ms
     FROM audit_log ORDER BY id DESC LIMIT ?`,
  )
  .all(n)
  .reverse();
db.close();

console.log(`Last ${rows.length} audit records (${path}), oldest first. Times are UTC.`);
console.table(rows);
