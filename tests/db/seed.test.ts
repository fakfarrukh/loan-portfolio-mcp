import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { seedDatabase } from '../../src/db/seed.js';
import { createTestDb, TEST_AS_OF } from '../helpers.js';

describe('seed', () => {
  const t = createTestDb();
  afterAll(() => {
    t.cleanup();
  });

  it('creates the requested volumes', () => {
    expect(t.stats.customers).toBe(200);
    expect(t.stats.loans).toBe(600);
    expect(t.stats.payments).toBeGreaterThan(4000);
    expect(t.stats.payments).toBeLessThan(7000);
    expect(t.stats.riskRatings).toBeGreaterThan(600);
  });

  it('produces a realistic, non-zero delinquency rate', () => {
    expect(t.stats.delinquencyRatePct).toBeGreaterThan(2);
    expect(t.stats.delinquencyRatePct).toBeLessThan(15);
  });

  it('is deterministic for the same seed and as-of date', () => {
    const a = new Database(':memory:');
    const b = new Database(':memory:');
    const sa = seedDatabase(a, { asOfDate: TEST_AS_OF, seed: 7, customers: 30, loans: 60 });
    const sb = seedDatabase(b, { asOfDate: TEST_AS_OF, seed: 7, customers: 30, loans: 60 });
    expect(sa).toEqual(sb);
    const dump = (db: Database.Database) =>
      db.prepare('SELECT loan_ref, current_balance_cents, status FROM loans ORDER BY id').all();
    expect(dump(a)).toEqual(dump(b));
  });

  it('only uses reserved example.com e-mail addresses (no real people)', () => {
    const db = new Database(t.dbPath, { readonly: true });
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM customers WHERE email NOT LIKE '%@example.com'")
      .get() as { n: number };
    db.close();
    expect(row.n).toBe(0);
  });

  it('derives loan status consistently with days past due', () => {
    const db = new Database(t.dbPath, { readonly: true });
    const bad = db
      .prepare(
        `SELECT COUNT(*) AS n FROM loans WHERE
           (status = 'current' AND days_past_due >= 30) OR
           (status = 'delinquent' AND (days_past_due < 30 OR days_past_due >= 90)) OR
           (status = 'default' AND days_past_due < 90) OR
           (status = 'paid_off' AND (current_balance_cents != 0 OR closed_date IS NULL))`,
      )
      .get() as { n: number };
    db.close();
    expect(bad.n).toBe(0);
  });
});
