import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/auth/principal.js';
import { AppError } from '../../src/errors.js';
import { SqlitePortfolioRepository } from '../../src/db/sqlite/portfolio-repository.js';
import { SearchLoansInput } from '../../src/schemas/tools.js';
import { admin, analyst, createTestDb, TEST_AS_OF, type TestDb } from '../helpers.js';

describe('SqlitePortfolioRepository', () => {
  let t: TestDb;
  let repo: SqlitePortfolioRepository;

  beforeAll(() => {
    t = createTestDb();
    repo = new SqlitePortfolioRepository(t.dbPath);
  });
  afterAll(() => {
    repo.close();
    t.cleanup();
  });

  const search = (p: Principal, q: Record<string, unknown> = {}) =>
    repo.searchLoans(p, SearchLoansInput.parse(q));

  it('reports the seeded as-of date', async () => {
    expect(await repo.getDataAsOfDate()).toBe(TEST_AS_OF);
  });

  describe('getPortfolioSummary', () => {
    it('returns totals consistent with seed statistics', async () => {
      const s = await repo.getPortfolioSummary(analyst, {});
      expect(s.totals.totalLoanCount).toBe(600);
      expect(s.totals.delinquencyRate).toBeCloseTo(t.stats.delinquencyRatePct, 1);
      expect(s.totals.activeLoanCount + s.totals.paidOffLoanCount).toBe(600);
      expect(s.totals.weightedAverageRate).toBeGreaterThan(0);
      expect(s.groups).toBeUndefined();
    });

    it('filters by region', async () => {
      const all = await repo.getPortfolioSummary(analyst, {});
      const west = await repo.getPortfolioSummary(analyst, { region: 'West' });
      expect(west.filters.region).toBe('West');
      expect(west.totals.totalLoanCount).toBeLessThan(all.totals.totalLoanCount);
    });

    it('groups by region and the groups add up to the total', async () => {
      const s = await repo.getPortfolioSummary(analyst, { groupBy: 'region' });
      expect(s.groups).toHaveLength(5);
      const sum = s.groups!.reduce((acc, g) => acc + g.activeLoanCount, 0);
      expect(sum).toBe(s.totals.activeLoanCount);
    });

    it('shows regional variation in delinquency', async () => {
      const s = await repo.getPortfolioSummary(analyst, { groupBy: 'region' });
      const rates = s.groups!.map((g) => g.delinquencyRate ?? 0);
      expect(Math.max(...rates) - Math.min(...rates)).toBeGreaterThan(2);
    });

    it('rejects an unsupported groupBy even if validation was bypassed', async () => {
      await expect(
        repo.getPortfolioSummary(analyst, { groupBy: 'customer_id' as never }),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('searchLoans', () => {
    it('masks customer names for analysts', async () => {
      const r = await search(analyst, { pageSize: 5 });
      expect(r.piiMasked).toBe(true);
      for (const item of r.items) expect(item.customerName).toMatch(/^\S\*\*\* \S\*\*\*$/);
    });

    it('shows full customer names to admins', async () => {
      const r = await search(admin, { pageSize: 5 });
      expect(r.piiMasked).toBe(false);
      for (const item of r.items) expect(item.customerName).not.toContain('***');
    });

    it('clamps pageSize to 50 even when called without schema validation', async () => {
      const r = await repo.searchLoans(analyst, {
        ...SearchLoansInput.parse({}),
        pageSize: 10_000,
      });
      expect(r.items.length).toBe(50);
      expect(r.pageSize).toBe(50);
    });

    it('paginates without overlap', async () => {
      const p1 = await search(analyst, { pageSize: 10, page: 1 });
      const p2 = await search(analyst, { pageSize: 10, page: 2 });
      const refs1 = new Set(p1.items.map((i) => i.loanRef));
      expect(p2.items.some((i) => refs1.has(i.loanRef))).toBe(false);
      expect(p1.hasMore).toBe(true);
      expect(p1.totalPages).toBe(Math.ceil(p1.totalCount / 10));
    });

    it('returns an empty page past the end', async () => {
      const r = await search(analyst, { page: 1000, pageSize: 50 });
      expect(r.items).toHaveLength(0);
      expect(r.hasMore).toBe(false);
    });

    it('applies status, region, balance and date filters', async () => {
      const r = await search(analyst, {
        status: ['delinquent', 'default'],
        region: 'Southeast',
        minBalance: 1000,
        originatedFrom: '2025-01-01',
        pageSize: 50,
      });
      expect(r.items.length).toBeGreaterThan(0);
      for (const i of r.items) {
        expect(['delinquent', 'default']).toContain(i.status);
        expect(i.region).toBe('Southeast');
        expect(i.currentBalance).toBeGreaterThanOrEqual(1000);
        expect(i.originationDate >= '2025-01-01').toBe(true);
      }
    });

    it('sorts by the requested column', async () => {
      const r = await search(analyst, {
        sortBy: 'days_past_due',
        sortDirection: 'desc',
        pageSize: 20,
      });
      const dpd = r.items.map((i) => i.daysPastDue);
      expect([...dpd].sort((a, b) => b - a)).toEqual(dpd);
    });

    it('rejects an unknown sort column even if validation was bypassed', async () => {
      await expect(
        repo.searchLoans(analyst, { ...SearchLoansInput.parse({}), sortBy: 'c.email' as never }),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('getLoanDetails', () => {
    it('returns the loan with payment history, newest first', async () => {
      const d = await repo.getLoanDetails(analyst, 'LN-000001', { paymentLimit: 120 });
      expect(d).not.toBeNull();
      expect(d!.loan.loanRef).toBe('LN-000001');
      const dates = d!.payments.map((p) => p.dueDate);
      expect([...dates].sort().reverse()).toEqual(dates);
      expect(d!.paymentSummary.returned).toBe(d!.payments.length);
    });

    it('masks name and e-mail for analysts, not for admins', async () => {
      const a = await repo.getLoanDetails(analyst, 'LN-000001', { paymentLimit: 1 });
      const b = await repo.getLoanDetails(admin, 'LN-000001', { paymentLimit: 1 });
      expect(a!.customer.name).toContain('***');
      expect(a!.customer.email).toMatch(/^.\*\*\*@example\.com$/);
      expect(b!.customer.name).not.toContain('***');
      expect(b!.customer.email).not.toContain('***');
    });

    it('limits payment history', async () => {
      const d = await repo.getLoanDetails(analyst, 'LN-000001', { paymentLimit: 2 });
      expect(d!.payments.length).toBeLessThanOrEqual(2);
    });

    it('returns null for a missing loan', async () => {
      expect(await repo.getLoanDetails(analyst, 'LN-999999', { paymentLimit: 5 })).toBeNull();
    });
  });

  describe('getDelinquencyTrend', () => {
    it('returns N month-ends ending at the as-of date', async () => {
      const tr = await repo.getDelinquencyTrend(analyst, { months: 6 });
      expect(tr.points).toHaveLength(6);
      expect(tr.points.at(-1)!.monthEnd).toBe(TEST_AS_OF);
      expect(tr.points[0]!.monthEnd).toBe('2026-05-31');
    });

    it('final point matches the summary delinquency rate (same definition)', async () => {
      const tr = await repo.getDelinquencyTrend(analyst, { months: 3 });
      const s = await repo.getPortfolioSummary(analyst, {});
      expect(tr.points.at(-1)!.delinquencyRate).toBe(s.totals.delinquencyRate);
      expect(tr.points.at(-1)!.activeLoans).toBe(s.totals.activeLoanCount);
    });

    it('also agrees per region', async () => {
      const tr = await repo.getDelinquencyTrend(analyst, { months: 1, region: 'Southeast' });
      const s = await repo.getPortfolioSummary(analyst, { region: 'Southeast' });
      expect(tr.points[0]!.delinquentLoans).toBe(s.totals.delinquentLoanCount);
    });
  });

  describe('security', () => {
    it('refuses to run without a valid principal', async () => {
      await expect(
        repo.getPortfolioSummary({ subject: 'x', role: 'superuser' } as unknown as Principal, {}),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('opens the portfolio database read-only', () => {
      const db = (repo as unknown as { db: Database.Database }).db;
      expect(db.readonly).toBe(true);
      expect(() => db.prepare('DELETE FROM loans').run()).toThrow();
    });
  });
});
