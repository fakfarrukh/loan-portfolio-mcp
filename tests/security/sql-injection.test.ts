import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { SearchLoansInput } from '../../src/schemas/tools.js';
import { admin } from '../helpers.js';
import { createHarness, expectErr } from '../tools/harness.js';

const PAYLOADS = [
  "' OR '1'='1",
  "West' OR '1'='1",
  "'; DROP TABLE loans; --",
  "LN-000001' OR 1=1 --",
  '1; DELETE FROM customers',
  "' UNION SELECT first_name, last_name, email FROM customers --",
  "West'); ATTACH DATABASE '/tmp/x.db' AS x; --",
  '\\x27 OR 1=1',
];

describe('SQL injection resistance', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  const tableCounts = () => {
    const db = new Database(h.db.dbPath, { readonly: true });
    try {
      return Object.fromEntries(
        ['customers', 'loans', 'payments', 'risk_ratings'].map((t) => [
          t,
          (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
        ]),
      );
    } finally {
      db.close();
    }
  };
  const before = tableCounts();

  describe('layer 1: tool input validation rejects payloads', () => {
    const cases: [string, (p: string) => Record<string, unknown>][] = [
      ['get_portfolio_summary', (p) => ({ region: p })],
      ['get_portfolio_summary', (p) => ({ loanType: p })],
      ['get_portfolio_summary', (p) => ({ groupBy: p })],
      ['search_loans', (p) => ({ region: p })],
      ['search_loans', (p) => ({ status: [p] })],
      ['search_loans', (p) => ({ sortBy: p })],
      ['search_loans', (p) => ({ sortDirection: p })],
      ['search_loans', (p) => ({ originatedFrom: p })],
      ['search_loans', (p) => ({ minBalance: p })],
      ['get_loan_details', (p) => ({ loanRef: p })],
      ['get_delinquency_trend', (p) => ({ region: p })],
      ['explain_metric', (p) => ({ metric: p })],
    ];

    for (const [tool, build] of cases) {
      it(`${tool} ${Object.keys(build('x'))[0]}`, async () => {
        for (const payload of PAYLOADS) {
          const e = expectErr(await h.call(tool, build(payload), admin));
          expect(e.code).toBe('INVALID_INPUT');
        }
      });
    }
  });

  describe('layer 2: parameterized queries treat payloads as data (validation bypassed)', () => {
    it('getLoanDetails: payload matches no loan', async () => {
      for (const p of PAYLOADS) {
        expect(await h.repo.getLoanDetails(admin, p, { paymentLimit: 5 })).toBeNull();
      }
    });

    it('searchLoans: payloads in filter values match nothing', async () => {
      const baseQuery = SearchLoansInput.parse({ pageSize: 50 });
      for (const p of PAYLOADS) {
        const byRegion = await h.repo.searchLoans(admin, { ...baseQuery, region: p as never });
        expect(byRegion.totalCount).toBe(0);
        const byStatus = await h.repo.searchLoans(admin, { ...baseQuery, status: [p as never] });
        expect(byStatus.totalCount).toBe(0);
        const byGrade = await h.repo.searchLoans(admin, { ...baseQuery, riskGrade: p as never });
        expect(byGrade.totalCount).toBe(0);
      }
    });

    it('summary and trend: payloads in filters match nothing', async () => {
      for (const p of PAYLOADS) {
        const s = await h.repo.getPortfolioSummary(admin, { region: p as never });
        expect(s.totals.totalLoanCount).toBe(0);
        const t = await h.repo.getDelinquencyTrend(admin, { months: 3, loanType: p as never });
        expect(t.points.every((pt) => pt.activeLoans === 0)).toBe(true);
      }
    });

    it('identifier positions (ORDER BY / GROUP BY) only accept allow-listed keys', async () => {
      const baseQuery = SearchLoansInput.parse({});
      for (const p of PAYLOADS) {
        await expect(
          h.repo.searchLoans(admin, { ...baseQuery, sortBy: p as never }),
        ).rejects.toBeInstanceOf(AppError);
        await expect(
          h.repo.searchLoans(admin, { ...baseQuery, sortDirection: p as never }),
        ).rejects.toBeInstanceOf(AppError);
        await expect(
          h.repo.getPortfolioSummary(admin, { groupBy: p as never }),
        ).rejects.toBeInstanceOf(AppError);
      }
      // Prototype keys must not resolve through the lookup maps either.
      await expect(
        h.repo.searchLoans(admin, { ...baseQuery, sortBy: 'constructor' as never }),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('the database is unchanged and intact afterwards', () => {
      expect(tableCounts()).toEqual(before);
      const db = new Database(h.db.dbPath, { readonly: true });
      try {
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        db.close();
      }
    });
  });

  describe('layer 3: static guard against string-built SQL', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
      });

    it('no prepare()/exec() call interpolates values into SQL text', () => {
      const offenders: string[] = [];
      // Matches .prepare(`...${...}`), .prepare('...' + x), .exec(`...${...}`)
      const interpolated = /\.(prepare|exec)(<[^>]*>)?\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/;
      // Self-check: the guard must actually catch the patterns it claims to.
      expect(interpolated.test('db.prepare(`SELECT * FROM loans WHERE id = ${id}`)')).toBe(true);
      expect(interpolated.test("db.prepare('SELECT * FROM loans WHERE region = ' + region)")).toBe(
        true,
      );
      expect(interpolated.test('db.prepare<[], Row>(`SELECT ${col} FROM t`)')).toBe(true);
      expect(interpolated.test('db.prepare(SQL_SEARCH_COUNT)')).toBe(false);
      for (const file of files(join(process.cwd(), 'src'))) {
        const src = readFileSync(file, 'utf8');
        if (interpolated.test(src)) offenders.push(file);
      }
      expect(offenders).toEqual([]);
    });
  });
});
