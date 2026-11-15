import { z } from 'zod';

/**
 * Domain vocabulary shared by the data layer, tool schemas and the data dictionary.
 * Keeping enums in one place means the LLM-facing JSON Schema, the SQL CHECK constraints
 * and the seed generator can never disagree about valid values.
 */

export const REGIONS = ['Northeast', 'Southeast', 'Midwest', 'Southwest', 'West'] as const;
export const LOAN_TYPES = ['mortgage', 'heloc', 'auto', 'personal', 'small_business'] as const;
export const LOAN_STATUSES = ['current', 'delinquent', 'default', 'paid_off'] as const;
export const RISK_GRADES = ['A', 'B', 'C', 'D', 'E'] as const;
export const PAYMENT_STATUSES = ['paid_on_time', 'paid_late', 'missed'] as const;
export const CUSTOMER_SEGMENTS = ['consumer', 'small_business'] as const;

export const RegionSchema = z.enum(REGIONS);
export const LoanTypeSchema = z.enum(LOAN_TYPES);
export const LoanStatusSchema = z.enum(LOAN_STATUSES);
export const RiskGradeSchema = z.enum(RISK_GRADES);
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const CustomerSegmentSchema = z.enum(CUSTOMER_SEGMENTS);

export type Region = z.infer<typeof RegionSchema>;
export type LoanType = z.infer<typeof LoanTypeSchema>;
export type LoanStatus = z.infer<typeof LoanStatusSchema>;
export type RiskGrade = z.infer<typeof RiskGradeSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type CustomerSegment = z.infer<typeof CustomerSegmentSchema>;

/** Business identifiers. IDs are validated by format before they reach the data layer. */
export const LoanRefSchema = z
  .string()
  .regex(/^LN-\d{6}$/, 'Loan reference must look like LN-000123')
  .describe('Loan reference, e.g. "LN-000123"');

export const CustomerRefSchema = z.string().regex(/^CUS-\d{5}$/);

/** Strict calendar date (YYYY-MM-DD) that must also be a real date. */
export const IsoDateSchema = z.iso.date().describe('Calendar date in YYYY-MM-DD format');

/** Hard ceiling on rows returned by any single list call. Also enforced in the data layer. */
export const MAX_PAGE_SIZE = 50;
export const MAX_PAYMENT_HISTORY = 120;
export const MAX_TREND_MONTHS = 36;
