/**
 * Every SQL statement the portfolio repository can execute.
 *
 * Rules:
 *  - All values are bound parameters (`@name`). Nothing from a request is ever interpolated.
 *  - Optional filters use the `(@p IS NULL OR col = @p)` pattern, so one static statement covers
 *    every filter combination.
 *  - The only dynamic parts — ORDER BY and GROUP BY — are chosen from the constant maps below by
 *    key lookup. The resulting SQL strings are fixed at build time.
 */

const ACTIVE = "l.status != 'paid_off'";
const DELINQUENT = `(${ACTIVE} AND l.days_past_due >= @delinquencyDays)`;
const DEFAULTED = `(${ACTIVE} AND l.days_past_due >= @defaultDays)`;

const SUMMARY_AGGREGATES = `
  COALESCE(SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END), 0)                          AS active_count,
  COALESCE(SUM(CASE WHEN ${ACTIVE} THEN l.current_balance_cents END), 0)           AS active_balance_cents,
  SUM(CASE WHEN ${ACTIVE} THEN l.interest_rate * l.current_balance_cents END)
    / NULLIF(SUM(CASE WHEN ${ACTIVE} THEN l.current_balance_cents END), 0)         AS weighted_avg_rate,
  AVG(CASE WHEN ${ACTIVE} THEN l.interest_rate END)                                AS simple_avg_rate,
  COALESCE(SUM(CASE WHEN ${DELINQUENT} THEN 1 ELSE 0 END), 0)                      AS delinquent_count,
  COALESCE(SUM(CASE WHEN ${DELINQUENT} THEN l.current_balance_cents END), 0)       AS delinquent_balance_cents,
  COALESCE(SUM(CASE WHEN ${DEFAULTED} THEN 1 ELSE 0 END), 0)                       AS default_count,
  COUNT(l.id)                                                                      AS total_count,
  COALESCE(SUM(CASE WHEN l.status = 'paid_off' THEN 1 ELSE 0 END), 0)              AS paid_off_count,
  COALESCE(SUM(l.principal_cents), 0)                                              AS originated_cents`;

const SUMMARY_FILTER = `
  WHERE (@region IS NULL OR l.region = @region)
    AND (@loanType IS NULL OR l.loan_type = @loanType)`;

export const SQL_AS_OF = `SELECT value FROM portfolio_meta WHERE key = 'as_of_date'`;

export const SQL_SUMMARY_TOTALS = `
SELECT ${SUMMARY_AGGREGATES}
FROM loans l
${SUMMARY_FILTER}`;

/** GROUP BY expressions, selected by key. */
export const GROUP_EXPRESSIONS = {
  region: 'l.region',
  loan_type: 'l.loan_type',
  risk_grade: "COALESCE(r.grade, 'unrated')",
} as const;

export const SQL_SUMMARY_GROUPED: Record<keyof typeof GROUP_EXPRESSIONS, string> =
  Object.fromEntries(
    Object.entries(GROUP_EXPRESSIONS).map(([key, expr]) => [
      key,
      `SELECT ${expr} AS group_key, ${SUMMARY_AGGREGATES}
     FROM loans l
     LEFT JOIN v_loan_latest_rating r ON r.loan_id = l.id
     ${SUMMARY_FILTER}
     GROUP BY ${expr}
     ORDER BY ${expr}`,
    ]),
  ) as Record<keyof typeof GROUP_EXPRESSIONS, string>;

// ------------------------------------------------------------------ search

const SEARCH_FROM = `
FROM loans l
JOIN customers c ON c.id = l.customer_id
LEFT JOIN v_loan_latest_rating r ON r.loan_id = l.id
WHERE (@statuses IS NULL OR l.status IN (SELECT value FROM json_each(@statuses)))
  AND (@region IS NULL OR l.region = @region)
  AND (@loanType IS NULL OR l.loan_type = @loanType)
  AND (@riskGrade IS NULL OR r.grade = @riskGrade)
  AND (@minBalanceCents IS NULL OR l.current_balance_cents >= @minBalanceCents)
  AND (@maxBalanceCents IS NULL OR l.current_balance_cents <= @maxBalanceCents)
  AND (@originatedFrom IS NULL OR l.origination_date >= @originatedFrom)
  AND (@originatedTo IS NULL OR l.origination_date <= @originatedTo)
  AND (@minDaysPastDue IS NULL OR l.days_past_due >= @minDaysPastDue)`;

export const SORT_COLUMNS = {
  current_balance: 'l.current_balance_cents',
  origination_date: 'l.origination_date',
  interest_rate: 'l.interest_rate',
  days_past_due: 'l.days_past_due',
} as const;

export const SORT_DIRECTIONS = { asc: 'ASC', desc: 'DESC' } as const;

export const SQL_SEARCH_COUNT = `SELECT COUNT(*) AS total ${SEARCH_FROM}`;

export function searchPageSql(
  sortColumn: (typeof SORT_COLUMNS)[keyof typeof SORT_COLUMNS],
  direction: (typeof SORT_DIRECTIONS)[keyof typeof SORT_DIRECTIONS],
): string {
  // Both arguments are typed as members of the constant maps above; the repository resolves
  // them by key lookup and rejects anything else before calling this.
  return `
SELECT l.loan_ref, c.customer_ref, c.first_name, c.last_name, l.loan_type, l.region, l.status,
       l.current_balance_cents, l.interest_rate, l.origination_date, l.days_past_due, r.grade
${SEARCH_FROM}
ORDER BY ${sortColumn} ${direction}, l.id ${direction}
LIMIT @limit OFFSET @offset`;
}

// ------------------------------------------------------------------ loan details

export const SQL_LOAN_BY_REF = `
SELECT l.id, l.loan_ref, l.loan_type, l.region, l.status, l.principal_cents, l.current_balance_cents,
       l.interest_rate, l.term_months, l.monthly_payment_cents, l.days_past_due,
       l.origination_date, l.maturity_date, l.closed_date,
       c.customer_ref, c.first_name, c.last_name, c.email, c.segment, c.customer_since
FROM loans l
JOIN customers c ON c.id = l.customer_id
WHERE l.loan_ref = @loanRef`;

export const SQL_LOAN_RATINGS = `
SELECT rating_date, grade, probability_of_default, rated_by
FROM risk_ratings
WHERE loan_id = @loanId
ORDER BY rating_date DESC, id DESC
LIMIT 50`;

export const SQL_LOAN_PAYMENTS = `
SELECT due_date, paid_date, amount_due_cents, amount_paid_cents, status, days_late
FROM payments
WHERE loan_id = @loanId
ORDER BY due_date DESC, id DESC
LIMIT @limit`;

export const SQL_LOAN_PAYMENT_SUMMARY = `
SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'paid_on_time' THEN 1 ELSE 0 END), 0) AS on_time,
       COALESCE(SUM(CASE WHEN status = 'paid_late' THEN 1 ELSE 0 END), 0)    AS late,
       COALESCE(SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END), 0)       AS missed
FROM payments
WHERE loan_id = @loanId`;

// ------------------------------------------------------------------ delinquency trend

/**
 * Recomputes delinquency at each month-end from payment history (see metric
 * `monthly_delinquency_rate`). Month i=0 is the as-of date itself; i>=1 is the last day of each
 * earlier month.
 */
export const SQL_DELINQUENCY_TREND = `
WITH RECURSIVE months(i, month_end) AS (
  SELECT 0, date(@asOf)
  UNION ALL
  SELECT i + 1, date(@asOf, 'start of month', printf('-%d months', i), '-1 day')
  FROM months
  WHERE i + 1 < @months
)
SELECT m.month_end,
       COUNT(l.id) AS active_loans,
       COALESCE(SUM(CASE WHEN EXISTS (
         SELECT 1 FROM payments p
         WHERE p.loan_id = l.id
           AND p.due_date <= date(m.month_end, printf('-%d days', @delinquencyDays))
           AND (p.paid_date IS NULL OR p.paid_date > m.month_end)
       ) THEN 1 ELSE 0 END), 0) AS delinquent_loans
FROM months m
LEFT JOIN loans l
  ON l.origination_date <= m.month_end
 AND (l.closed_date IS NULL OR l.closed_date > m.month_end)
 AND (@region IS NULL OR l.region = @region)
 AND (@loanType IS NULL OR l.loan_type = @loanType)
GROUP BY m.month_end
ORDER BY m.month_end ASC`;
