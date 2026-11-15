import { afterAll, describe, expect, it } from 'vitest';
import type { LoanDetails } from '../../src/schemas/tools.js';
import { admin, analyst } from '../helpers.js';
import { createHarness, expectErr, expectOk } from './harness.js';

describe('get_loan_details', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  it('returns loan, customer, ratings and newest-first payments', async () => {
    const d = expectOk<LoanDetails>(
      await h.call('get_loan_details', { loanRef: 'LN-000010' }, analyst),
    );
    expect(d.loan.loanRef).toBe('LN-000010');
    expect(d.riskRatings.length).toBeGreaterThan(0);
    expect(d.payments.length).toBeLessThanOrEqual(24);
    expect(d.paymentSummary.totalScheduled).toBe(
      d.paymentSummary.paidOnTime + d.paymentSummary.paidLate + d.paymentSummary.missed,
    );
  });

  it('masks customer PII for analysts and reveals it for admins', async () => {
    const a = expectOk<LoanDetails>(
      await h.call('get_loan_details', { loanRef: 'LN-000010' }, analyst),
    );
    const b = expectOk<LoanDetails>(
      await h.call('get_loan_details', { loanRef: 'LN-000010' }, admin),
    );
    expect(a.piiMasked).toBe(true);
    expect(a.customer.name).toMatch(/\*\*\*/);
    expect(a.customer.email).toMatch(/^.\*\*\*@/);
    expect(b.piiMasked).toBe(false);
    expect(b.customer.name).not.toMatch(/\*/);
    expect(b.customer.customerRef).toBe(a.customer.customerRef);
  });

  it('honours paymentLimit and rejects values over 120', async () => {
    const d = expectOk<LoanDetails>(
      await h.call('get_loan_details', { loanRef: 'LN-000010', paymentLimit: 3 }, analyst),
    );
    expect(d.payments.length).toBeLessThanOrEqual(3);
    expect(d.paymentSummary.returned).toBe(d.payments.length);
    const e = expectErr(
      await h.call('get_loan_details', { loanRef: 'LN-000010', paymentLimit: 121 }, analyst),
    );
    expect(e.code).toBe('INVALID_INPUT');
  });

  it('returns NOT_FOUND for a well-formed but unknown reference', async () => {
    const e = expectErr(await h.call('get_loan_details', { loanRef: 'LN-999999' }, analyst));
    expect(e.code).toBe('NOT_FOUND');
    expect(h.audit.recent(1)[0]).toMatchObject({ outcome: 'not_found', error_code: 'NOT_FOUND' });
  });

  it('rejects malformed references before touching the database', async () => {
    for (const loanRef of ['123', 'LN-1', 'ln-000001', 'LN-0000001', '', 42]) {
      expect(expectErr(await h.call('get_loan_details', { loanRef }, analyst)).code).toBe(
        'INVALID_INPUT',
      );
    }
  });

  it('requires loanRef', async () => {
    const e = expectErr(await h.call('get_loan_details', {}, analyst));
    expect(e.details).toEqual([expect.objectContaining({ path: 'loanRef' })]);
  });
});
