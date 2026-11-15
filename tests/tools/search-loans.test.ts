import { afterAll, describe, expect, it } from 'vitest';
import type { SearchLoansResult } from '../../src/schemas/tools.js';
import { admin, analyst } from '../helpers.js';
import { createHarness, expectErr, expectOk } from './harness.js';

describe('search_loans', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  const search = async (args: unknown, who = analyst) =>
    expectOk<SearchLoansResult>(await h.call('search_loans', args, who));

  it('defaults to 20 rows sorted by balance descending', async () => {
    const r = await search({});
    expect(r.items).toHaveLength(20);
    expect(r.pageSize).toBe(20);
    const balances = r.items.map((i) => i.currentBalance);
    expect([...balances].sort((a, b) => b - a)).toEqual(balances);
  });

  describe('pagination limits', () => {
    it('allows exactly 50 rows per page', async () => {
      const r = await search({ pageSize: 50 });
      expect(r.items).toHaveLength(50);
    });

    it('rejects pageSize above 50', async () => {
      const e = expectErr(await h.call('search_loans', { pageSize: 51 }, analyst));
      expect(e.code).toBe('INVALID_INPUT');
      expect(e.details).toEqual([expect.objectContaining({ path: 'pageSize' })]);
    });

    it('rejects pageSize 0, negative and fractional values', async () => {
      for (const pageSize of [0, -5, 2.5]) {
        expect(expectErr(await h.call('search_loans', { pageSize }, analyst)).code).toBe(
          'INVALID_INPUT',
        );
      }
    });

    it('rejects page numbers beyond the hard ceiling', async () => {
      expect(expectErr(await h.call('search_loans', { page: 1001 }, analyst)).code).toBe(
        'INVALID_INPUT',
      );
    });

    it('walks every page exactly once', async () => {
      const first = await search({ pageSize: 50 });
      const seen = new Set<string>();
      for (let page = 1; page <= first.totalPages; page++) {
        const r = await search({ pageSize: 50, page });
        r.items.forEach((i) => seen.add(i.loanRef));
        expect(r.hasMore).toBe(page < first.totalPages);
      }
      expect(seen.size).toBe(first.totalCount);
    });
  });

  describe('permission masking', () => {
    it('masks customer names for analysts', async () => {
      const r = await search({ pageSize: 10 }, analyst);
      expect(r.piiMasked).toBe(true);
      expect(r.items.every((i) => /^\S\*\*\*( \S\*\*\*)*$/.test(i.customerName))).toBe(true);
    });

    it('returns real names to admins', async () => {
      const r = await search({ pageSize: 10 }, admin);
      expect(r.piiMasked).toBe(false);
      expect(r.items.every((i) => !i.customerName.includes('*'))).toBe(true);
    });

    it('cannot be bypassed with extra arguments', async () => {
      const e = expectErr(
        await h.call('search_loans', { pageSize: 5, unmask: true, role: 'admin' }, analyst),
      );
      expect(e.code).toBe('INVALID_INPUT');
    });
  });

  describe('filters and validation', () => {
    it('filters by status list', async () => {
      const r = await search({ status: ['default'], pageSize: 50 });
      expect(r.totalCount).toBeGreaterThan(0);
      expect(r.items.every((i) => i.status === 'default')).toBe(true);
    });

    it('filters by balance range and origination window', async () => {
      const r = await search({
        minBalance: 10_000,
        maxBalance: 50_000,
        originatedFrom: '2025-06-01',
        originatedTo: '2026-06-30',
        pageSize: 50,
      });
      for (const i of r.items) {
        expect(i.currentBalance).toBeGreaterThanOrEqual(10_000);
        expect(i.currentBalance).toBeLessThanOrEqual(50_000);
        expect(i.originationDate >= '2025-06-01' && i.originationDate <= '2026-06-30').toBe(true);
      }
    });

    it('rejects minBalance > maxBalance', async () => {
      const e = expectErr(await h.call('search_loans', { minBalance: 10, maxBalance: 5 }, analyst));
      expect(e.code).toBe('INVALID_INPUT');
    });

    it('rejects impossible or malformed dates', async () => {
      for (const d of ['2026-02-30', '31/12/2025', '2026-1-1']) {
        expect(expectErr(await h.call('search_loans', { originatedFrom: d }, analyst)).code).toBe(
          'INVALID_INPUT',
        );
      }
    });

    it('rejects unknown status and sort values', async () => {
      expect(expectErr(await h.call('search_loans', { status: ['late'] }, analyst)).code).toBe(
        'INVALID_INPUT',
      );
      expect(expectErr(await h.call('search_loans', { sortBy: 'email' }, analyst)).code).toBe(
        'INVALID_INPUT',
      );
    });

    it('audits the number of rows returned', async () => {
      await search({ pageSize: 7 });
      expect(h.audit.recent(1)[0]).toMatchObject({
        kind: 'tool',
        name: 'search_loans',
        row_count: 7,
      });
    });
  });
});
