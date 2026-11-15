import { afterAll, describe, expect, it } from 'vitest';
import type { PortfolioSummary } from '../../src/schemas/tools.js';
import { admin, analyst } from '../helpers.js';
import { createHarness, expectErr, expectOk } from './harness.js';

describe('get_portfolio_summary', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  it('returns portfolio totals', async () => {
    const s = expectOk<PortfolioSummary>(await h.call('get_portfolio_summary', {}, analyst));
    expect(s.totals.totalLoanCount).toBe(600);
    expect(s.totals.delinquencyRate).toBeGreaterThan(0);
    expect(s.filters).toEqual({ region: null, loanType: null });
  });

  it('accepts region, loanType and groupBy', async () => {
    const s = expectOk<PortfolioSummary>(
      await h.call('get_portfolio_summary', { region: 'West', groupBy: 'loan_type' }, admin),
    );
    expect(s.filters.region).toBe('West');
    expect(s.groupBy).toBe('loan_type');
    expect(s.groups!.length).toBeGreaterThan(0);
  });

  it('rejects an invalid region with a field-level error', async () => {
    const e = expectErr(await h.call('get_portfolio_summary', { region: 'Atlantis' }, analyst));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.details).toEqual([expect.objectContaining({ path: 'region' })]);
  });

  it('rejects unknown keys instead of silently ignoring them', async () => {
    const e = expectErr(await h.call('get_portfolio_summary', { regoin: 'West' }, analyst));
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('rejects non-object arguments', async () => {
    const e = expectErr(await h.call('get_portfolio_summary', 'West', analyst));
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('writes an audit record with validated arguments and row count', async () => {
    await h.call('get_portfolio_summary', { region: 'Midwest', groupBy: 'risk_grade' }, analyst);
    const [row] = h.audit.recent(1);
    expect(row).toMatchObject({
      subject: analyst.subject,
      role: 'analyst',
      kind: 'tool',
      name: 'get_portfolio_summary',
      outcome: 'success',
      error_code: null,
    });
    expect(JSON.parse(row!.arguments_json as string)).toEqual({
      region: 'Midwest',
      groupBy: 'risk_grade',
    });
    expect(row!.row_count).toBeGreaterThan(1);
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
