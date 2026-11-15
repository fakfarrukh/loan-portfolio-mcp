import { afterAll, describe, expect, it } from 'vitest';
import { METRICS } from '../../src/schemas/metrics.js';
import { analyst } from '../helpers.js';
import { createHarness, expectErr, expectOk } from './harness.js';

interface Out {
  metrics: { id: string; formula: string; definition: string }[];
}

describe('explain_metric', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  it('lists every metric when called without arguments', async () => {
    const r = expectOk<Out>(await h.call('explain_metric', {}, analyst));
    expect(r.metrics.map((m) => m.id)).toEqual(METRICS.map((m) => m.id));
    for (const m of r.metrics) {
      expect(m.definition.length).toBeGreaterThan(10);
      expect(m.formula.length).toBeGreaterThan(5);
    }
  });

  it('returns a single metric', async () => {
    const r = expectOk<Out>(
      await h.call('explain_metric', { metric: 'delinquency_rate' }, analyst),
    );
    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0]!.formula).toContain('days_past_due >= 30');
  });

  it('rejects unknown metrics and lists valid options', async () => {
    const e = expectErr(await h.call('explain_metric', { metric: 'npl_ratio' }, analyst));
    expect(e.code).toBe('INVALID_INPUT');
    expect(JSON.stringify(e.details)).toContain('delinquency_rate');
  });

  it('covers every metric that get_portfolio_summary reports', () => {
    const ids = new Set<string>(METRICS.map((m) => m.id));
    for (const id of [
      'active_loan_count',
      'total_outstanding_balance',
      'weighted_average_rate',
      'simple_average_rate',
      'delinquency_rate',
      'delinquent_balance_rate',
      'default_rate',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});
