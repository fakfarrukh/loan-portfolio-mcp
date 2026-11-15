import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, lastDayOfPreviousMonth } from '../../src/db/dates.js';
import { maskEmail, maskName, piiPolicyFor } from '../../src/db/masking.js';
import { admin, analyst } from '../helpers.js';

describe('dates', () => {
  it('adds months with end-of-month clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
  });
  it('adds days and measures differences', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });
  it('finds the last day of the previous month', () => {
    expect(lastDayOfPreviousMonth(new Date('2026-03-10T00:00:00Z'))).toBe('2026-02-28');
  });
  it('rejects invalid dates', () => {
    expect(() => addDays('not-a-date', 1)).toThrow(RangeError);
  });
});

describe('masking', () => {
  it('masks names without leaking length', () => {
    expect(maskName('Jonathan Smithers')).toBe('J*** S***');
    expect(maskName('Al Li')).toBe('A*** L***');
  });
  it('masks e-mail local part', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@example.com');
    expect(maskEmail('broken')).toBe('***');
  });
  it('applies policy by role', () => {
    expect(piiPolicyFor(analyst).masked).toBe(true);
    expect(piiPolicyFor(analyst).name('Jane Doe')).toBe('J*** D***');
    expect(piiPolicyFor(admin).masked).toBe(false);
    expect(piiPolicyFor(admin).name('Jane Doe')).toBe('Jane Doe');
  });
});
