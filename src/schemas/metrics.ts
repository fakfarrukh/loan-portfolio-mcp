/**
 * Single source of truth for every metric the server reports.
 *
 * `explain_metric` returns these definitions verbatim, and the SQL in the data layer implements
 * exactly these formulas (see src/db/sqlite/queries.ts). If you change a formula, change it here
 * and in the query together — the tests assert they agree.
 */
export interface MetricDefinition {
  id: string;
  name: string;
  definition: string;
  formula: string;
  unit: 'USD' | 'percent' | 'count' | 'days';
  population: string;
  notes?: string;
}

export const ACTIVE_LOAN_POPULATION =
  "Active loans: status is not 'paid_off' at the data as-of date (includes delinquent and defaulted loans).";

export const DELINQUENCY_THRESHOLD_DAYS = 30;
export const DEFAULT_THRESHOLD_DAYS = 90;

export const METRICS = [
  {
    id: 'active_loan_count',
    name: 'Active loan count',
    definition: 'Number of loans still on the books.',
    formula: "COUNT(loans WHERE status != 'paid_off')",
    unit: 'count',
    population: ACTIVE_LOAN_POPULATION,
  },
  {
    id: 'total_outstanding_balance',
    name: 'Total outstanding balance',
    definition: 'Sum of unpaid principal across active loans.',
    formula: 'SUM(current_balance) over active loans',
    unit: 'USD',
    population: ACTIVE_LOAN_POPULATION,
  },
  {
    id: 'total_originated_principal',
    name: 'Total originated principal',
    definition:
      'Sum of original principal for all loans ever originated, including paid-off loans.',
    formula: 'SUM(principal_amount) over all loans',
    unit: 'USD',
    population: 'All loans, any status.',
  },
  {
    id: 'weighted_average_rate',
    name: 'Weighted average interest rate (WAR)',
    definition:
      'Average annual interest rate weighted by outstanding balance, so large loans count more. This is the standard portfolio yield measure.',
    formula: 'SUM(interest_rate × current_balance) / SUM(current_balance) over active loans',
    unit: 'percent',
    population: ACTIVE_LOAN_POPULATION,
  },
  {
    id: 'simple_average_rate',
    name: 'Simple average interest rate',
    definition: 'Unweighted mean annual interest rate; every loan counts equally.',
    formula: 'AVG(interest_rate) over active loans',
    unit: 'percent',
    population: ACTIVE_LOAN_POPULATION,
    notes:
      'Usually higher than WAR because small personal loans carry higher rates. Prefer WAR when describing portfolio yield.',
  },
  {
    id: 'delinquency_rate',
    name: 'Delinquency rate (count basis)',
    definition: `Share of active loans that are ${DELINQUENCY_THRESHOLD_DAYS} or more days past due. Includes defaulted loans.`,
    formula: `COUNT(active loans WHERE days_past_due >= ${DELINQUENCY_THRESHOLD_DAYS}) / COUNT(active loans) × 100`,
    unit: 'percent',
    population: ACTIVE_LOAN_POPULATION,
    notes:
      "Equivalent to status IN ('delinquent','default'). Loans 1-29 days past due are still 'current'.",
  },
  {
    id: 'delinquent_balance_rate',
    name: 'Delinquency rate (balance basis)',
    definition: `Share of outstanding balance held in loans ${DELINQUENCY_THRESHOLD_DAYS}+ days past due.`,
    formula: `SUM(current_balance WHERE days_past_due >= ${DELINQUENCY_THRESHOLD_DAYS}) / SUM(current_balance) × 100 over active loans`,
    unit: 'percent',
    population: ACTIVE_LOAN_POPULATION,
    notes:
      'Differs from the count-basis rate when delinquencies are concentrated in large or small loans.',
  },
  {
    id: 'default_rate',
    name: 'Default rate',
    definition: `Share of active loans ${DEFAULT_THRESHOLD_DAYS} or more days past due (status 'default').`,
    formula: `COUNT(active loans WHERE days_past_due >= ${DEFAULT_THRESHOLD_DAYS}) / COUNT(active loans) × 100`,
    unit: 'percent',
    population: ACTIVE_LOAN_POPULATION,
  },
  {
    id: 'days_past_due',
    name: 'Days past due (DPD)',
    definition:
      'How many days the oldest unpaid scheduled payment is overdue at the as-of date. 0 if nothing is unpaid.',
    formula: 'as_of_date − MIN(due_date of payments unpaid at as_of_date)',
    unit: 'days',
    population: 'Per loan.',
  },
  {
    id: 'monthly_delinquency_rate',
    name: 'Monthly delinquency rate (trend)',
    definition: `Delinquency rate recomputed at each month-end from payment history: a loan counts as delinquent at month-end M if any payment due on or before (M − ${DELINQUENCY_THRESHOLD_DAYS} days) was still unpaid at M.`,
    formula: `COUNT(loans active at M with a payment due <= M−${DELINQUENCY_THRESHOLD_DAYS}d unpaid at M) / COUNT(loans active at M) × 100`,
    unit: 'percent',
    population:
      'Loans originated on or before M and not closed (paid off) on or before M. The final point equals delinquency_rate at the as-of date.',
  },
] as const satisfies readonly MetricDefinition[];

export type MetricId = (typeof METRICS)[number]['id'];
export const METRIC_IDS = METRICS.map((m) => m.id) as [MetricId, ...MetricId[]];
