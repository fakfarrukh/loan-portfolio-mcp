import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Principal } from '../src/auth/principal.js';
import { seedDatabase, type SeedStats } from '../src/db/seed.js';

export const TEST_AS_OF = '2026-10-31';
export const TEST_SEED = 42;

export const analyst: Principal = { subject: 'alice@test', role: 'analyst', authMethod: 'jwt' };
export const admin: Principal = { subject: 'bob@test', role: 'admin', authMethod: 'jwt' };

export interface TestDb {
  dir: string;
  dbPath: string;
  auditPath: string;
  stats: SeedStats;
  cleanup: () => void;
}

/** Seeds a fresh, deterministic portfolio DB in a temp directory. */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'loan-mcp-test-'));
  const dbPath = join(dir, 'portfolio.db');
  const db = new Database(dbPath);
  const stats = seedDatabase(db, { asOfDate: TEST_AS_OF, seed: TEST_SEED });
  db.close();
  return {
    dir,
    dbPath,
    auditPath: join(dir, 'audit.db'),
    stats,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
