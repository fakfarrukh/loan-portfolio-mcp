import { z } from 'zod';
import {
  CustomerRefSchema,
  CustomerSegmentSchema,
  IsoDateSchema,
  LoanRefSchema,
  LoanStatusSchema,
  LoanTypeSchema,
  MAX_PAGE_SIZE,
  MAX_PAYMENT_HISTORY,
  MAX_TREND_MONTHS,
  PaymentStatusSchema,
  RegionSchema,
  RiskGradeSchema,
} from './domain.js';
import { METRIC_IDS } from './metrics.js';

/**
 * Input and output contracts for every tool.
 *
 * - Inputs use `z.strictObject` so unknown keys are rejected rather than silently ignored
 *   (an LLM passing `{"regoin": "West"}` gets a clear error instead of unfiltered data).
 * - Outputs are parsed before returning. They act as an allow-list: a field the data layer
 *   accidentally adds will never reach the client.
 * - `.describe()` text is what the LLM sees in the JSON Schema, so it is written for the model.
 */

const Usd = z.number().describe('US dollars, rounded to cents');
const Pct = z.number().describe('Percentage, e.g. 6.25 means 6.25%');

// ------------------------------------------------------------------ get_portfolio_summary

export const PortfolioSummaryInput = z.strictObject({
  region: RegionSchema.optional().describe('Restrict to one region. Omit for the whole portfolio.'),
  loanType: LoanTypeSchema.optional().describe('Restrict to one loan type.'),
  groupBy: z
    .enum(['region', 'loan_type', 'risk_grade'])
    .optional()
    .describe('Also return the same metrics broken down by this dimension.'),
});

const SummaryMetrics = z.strictObject({
  activeLoanCount: z.number().int(),
  totalOutstandingBalance: Usd,
  weightedAverageRate: Pct.nullable(),
  simpleAverageRate: Pct.nullable(),
  delinquentLoanCount: z.number().int(),
  delinquencyRate: Pct.nullable(),
  delinquentBalance: Usd,
  delinquentBalanceRate: Pct.nullable(),
  defaultedLoanCount: z.number().int(),
  defaultRate: Pct.nullable(),
});

export const PortfolioSummaryOutput = z.strictObject({
  asOfDate: IsoDateSchema,
  filters: z.strictObject({
    region: RegionSchema.nullable(),
    loanType: LoanTypeSchema.nullable(),
  }),
  totals: SummaryMetrics.extend({
    totalLoanCount: z.number().int().describe('All loans including paid off'),
    paidOffLoanCount: z.number().int(),
    totalOriginatedPrincipal: Usd,
  }),
  groups: z
    .array(SummaryMetrics.extend({ group: z.string() }))
    .optional()
    .describe('Present only when groupBy was supplied'),
  groupBy: z.enum(['region', 'loan_type', 'risk_grade']).optional(),
});

// ------------------------------------------------------------------ search_loans

export const SORT_FIELDS = [
  'current_balance',
  'origination_date',
  'interest_rate',
  'days_past_due',
] as const;

export const SearchLoansInput = z
  .strictObject({
    status: z
      .array(LoanStatusSchema)
      .min(1)
      .max(4)
      .optional()
      .describe("Match any of these statuses, e.g. ['delinquent','default']"),
    region: RegionSchema.optional(),
    loanType: LoanTypeSchema.optional(),
    riskGrade: RiskGradeSchema.optional().describe('Latest risk grade, A (best) to E (worst)'),
    minBalance: z.number().min(0).max(1e9).optional().describe('Minimum current balance in USD'),
    maxBalance: z.number().min(0).max(1e9).optional().describe('Maximum current balance in USD'),
    originatedFrom: IsoDateSchema.optional().describe('Origination date on or after (inclusive)'),
    originatedTo: IsoDateSchema.optional().describe('Origination date on or before (inclusive)'),
    minDaysPastDue: z.number().int().min(0).max(3650).optional(),
    sortBy: z.enum(SORT_FIELDS).default('current_balance'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
    page: z.number().int().min(1).max(1000).default(1).describe('1-based page number'),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(20)
      .describe(`Rows per page, at most ${MAX_PAGE_SIZE}`),
  })
  .refine(
    (v) => v.minBalance === undefined || v.maxBalance === undefined || v.minBalance <= v.maxBalance,
    { message: 'minBalance must be less than or equal to maxBalance', path: ['minBalance'] },
  )
  .refine(
    (v) =>
      v.originatedFrom === undefined ||
      v.originatedTo === undefined ||
      v.originatedFrom <= v.originatedTo,
    { message: 'originatedFrom must be on or before originatedTo', path: ['originatedFrom'] },
  );

export type SearchLoansQuery = z.output<typeof SearchLoansInput>;

const CustomerName = z
  .string()
  .describe('Customer name. Masked (e.g. "J*** S***") unless the caller has the admin role.');

export const LoanListItem = z.strictObject({
  loanRef: LoanRefSchema,
  customerRef: CustomerRefSchema,
  customerName: CustomerName,
  loanType: LoanTypeSchema,
  region: RegionSchema,
  status: LoanStatusSchema,
  currentBalance: Usd,
  interestRate: Pct,
  originationDate: IsoDateSchema,
  daysPastDue: z.number().int(),
  riskGrade: RiskGradeSchema.nullable(),
});
export type LoanListItem = z.infer<typeof LoanListItem>;

export const SearchLoansOutput = z.strictObject({
  items: z.array(LoanListItem).max(MAX_PAGE_SIZE),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalCount: z.number().int(),
  totalPages: z.number().int(),
  hasMore: z.boolean(),
  piiMasked: z.boolean().describe('True when customer names were masked for this caller'),
});

// ------------------------------------------------------------------ get_loan_details

export const LoanDetailsInput = z.strictObject({
  loanRef: LoanRefSchema,
  paymentLimit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAYMENT_HISTORY)
    .default(24)
    .describe('How many of the most recent payments to include'),
});

export const PaymentRecord = z.strictObject({
  dueDate: IsoDateSchema,
  paidDate: IsoDateSchema.nullable(),
  amountDue: Usd,
  amountPaid: Usd,
  status: PaymentStatusSchema,
  daysLate: z.number().int().nullable(),
});

export const RiskRatingRecord = z.strictObject({
  ratingDate: IsoDateSchema,
  grade: RiskGradeSchema,
  probabilityOfDefault: Pct,
  ratedBy: z.string(),
});

export const LoanDetailsOutput = z.strictObject({
  loan: LoanListItem.omit({ customerName: true, customerRef: true, riskGrade: true }).extend({
    principalAmount: Usd,
    termMonths: z.number().int(),
    maturityDate: IsoDateSchema,
    closedDate: IsoDateSchema.nullable(),
    monthlyPayment: Usd,
  }),
  customer: z.strictObject({
    customerRef: CustomerRefSchema,
    name: CustomerName,
    email: z.string().describe('Masked unless the caller has the admin role'),
    segment: CustomerSegmentSchema,
    customerSince: IsoDateSchema,
  }),
  riskRatings: z.array(RiskRatingRecord).describe('Newest first'),
  payments: z.array(PaymentRecord).max(MAX_PAYMENT_HISTORY).describe('Newest first'),
  paymentSummary: z.strictObject({
    totalScheduled: z.number().int(),
    paidOnTime: z.number().int(),
    paidLate: z.number().int(),
    missed: z.number().int(),
    returned: z.number().int().describe('How many payments are included in `payments`'),
  }),
  piiMasked: z.boolean(),
});
export type LoanDetails = z.infer<typeof LoanDetailsOutput>;

// ------------------------------------------------------------------ get_delinquency_trend

export const DelinquencyTrendInput = z.strictObject({
  months: z
    .number()
    .int()
    .min(1)
    .max(MAX_TREND_MONTHS)
    .default(12)
    .describe(
      `Number of month-ends to return, ending at the data as-of date (max ${MAX_TREND_MONTHS})`,
    ),
  region: RegionSchema.optional(),
  loanType: LoanTypeSchema.optional(),
});

export const DelinquencyTrendOutput = z.strictObject({
  asOfDate: IsoDateSchema,
  filters: z.strictObject({
    region: RegionSchema.nullable(),
    loanType: LoanTypeSchema.nullable(),
  }),
  points: z.array(
    z.strictObject({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      monthEnd: IsoDateSchema,
      activeLoans: z.number().int(),
      delinquentLoans: z.number().int(),
      delinquencyRate: Pct.nullable(),
    }),
  ),
});

// ------------------------------------------------------------------ explain_metric

export const ExplainMetricInput = z.strictObject({
  metric: z
    .enum(METRIC_IDS)
    .optional()
    .describe('Metric id to explain. Omit to list every metric.'),
});

export const MetricDefinitionOutput = z.strictObject({
  id: z.string(),
  name: z.string(),
  definition: z.string(),
  formula: z.string(),
  unit: z.enum(['USD', 'percent', 'count', 'days']),
  population: z.string(),
  notes: z.string().optional(),
});

export const ExplainMetricOutput = z.strictObject({
  metrics: z.array(MetricDefinitionOutput),
});

export type PortfolioSummary = z.infer<typeof PortfolioSummaryOutput>;
export type SearchLoansResult = z.infer<typeof SearchLoansOutput>;
export type DelinquencyTrend = z.infer<typeof DelinquencyTrendOutput>;
