import { afterAll, describe, expect, it } from 'vitest';
import type { DelinquencyTrend, PortfolioSummary } from '../../src/schemas/tools.js';
import { analyst, TEST_AS_OF } from '../helpers.js';
import { createHarness, expectErr, expectOk } from './harness.js';

describe('get_delinquency_trend', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  it('defaults to 12 monthly points, oldest first, ending at the as-of date', async () => {
    const t = expectOk<DelinquencyTrend>(await h.call('get_delinquency_trend', {}, analyst));
    expect(t.points).toHaveLength(12);
    expect(t.points.at(-1)!.monthEnd).toBe(TEST_AS_OF);
    const months = t.points.map((p) => p.month);
    expect([...months].sort()).toEqual(months);
    expect(new Set(months).size).toBe(12);
  });

  it('shows the seeded deterioration over the last six months', async () => {
    const t = expectOk<DelinquencyTrend>(
      await h.call('get_delinquency_trend', { months: 12 }, analyst),
    );
    const early = t.points.slice(0, 6).map((p) => p.delinquencyRate ?? 0);
    const late = t.points.slice(6).map((p) => p.delinquencyRate ?? 0);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(late)).toBeGreaterThan(avg(early));
  });

  it('agrees with get_portfolio_summary for the same filter', async () => {
    const args = { region: 'Southwest', loanType: 'personal' } as const;
    const t = expectOk<DelinquencyTrend>(
      await h.call('get_delinquency_trend', { ...args, months: 1 }, analyst),
    );
    const s = expectOk<PortfolioSummary>(await h.call('get_portfolio_summary', args, analyst));
    expect(t.points[0]!.delinquencyRate).toBe(s.totals.delinquencyRate);
  });

  it('rejects months outside 1-36', async () => {
    for (const months of [0, 37, 1.5, '12']) {
      expect(expectErr(await h.call('get_delinquency_trend', { months }, analyst)).code).toBe(
        'INVALID_INPUT',
      );
    }
  });
});
