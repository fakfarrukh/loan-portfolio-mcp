import Database from 'better-sqlite3';
import { isRole, type Principal } from '../../auth/principal.js';
import { AppError, ErrorCode } from '../../errors.js';
import {
  MAX_PAGE_SIZE,
  MAX_PAYMENT_HISTORY,
  MAX_TREND_MONTHS,
  type LoanStatus,
  type LoanType,
  type PaymentStatus,
  type Region,
  type RiskGrade,
  type CustomerSegment,
} from '../../schemas/domain.js';
import { DEFAULT_THRESHOLD_DAYS, DELINQUENCY_THRESHOLD_DAYS } from '../../schemas/metrics.js';
import type {
  DelinquencyTrend,
  LoanDetails,
  PortfolioSummary,
  SearchLoansQuery,
  SearchLoansResult,
} from '../../schemas/tools.js';
import { piiPolicyFor } from '../masking.js';
import type { PortfolioRepository } from '../repository.js';
import type { GROUP_EXPRESSIONS } from './queries.js';
import {
  SORT_COLUMNS,
  SORT_DIRECTIONS,
  SQL_AS_OF,
  SQL_DELINQUENCY_TREND,
  SQL_LOAN_BY_REF,
  SQL_LOAN_PAYMENT_SUMMARY,
  SQL_LOAN_PAYMENTS,
  SQL_LOAN_RATINGS,
  SQL_SEARCH_COUNT,
  SQL_SUMMARY_GROUPED,
  SQL_SUMMARY_TOTALS,
  searchPageSql,
} from './queries.js';

// ---- row shapes returned by SQLite (snake_case, cents) --------------------------------------

interface AggregateRow {
  active_count: number;
  active_balance_cents: number;
  weighted_avg_rate: number | null;
  simple_avg_rate: number | null;
  delinquent_count: number;
  delinquent_balance_cents: number;
  default_count: number;
  total_count: number;
  paid_off_count: number;
  originated_cents: number;
}

interface SearchRow {
  loan_ref: string;
  customer_ref: string;
  first_name: string;
  last_name: string;
  loan_type: LoanType;
  region: Region;
  status: LoanStatus;
  current_balance_cents: number;
  interest_rate: number;
  origination_date: string;
  days_past_due: number;
  grade: RiskGrade | null;
}

interface LoanRow {
  id: number;
  loan_ref: string;
  loan_type: LoanType;
  region: Region;
  status: LoanStatus;
  principal_cents: number;
  current_balance_cents: number;
  interest_rate: number;
  term_months: number;
  monthly_payment_cents: number;
  days_past_due: number;
  origination_date: string;
  maturity_date: string;
  closed_date: string | null;
  customer_ref: string;
  first_name: string;
  last_name: string;
  email: string;
  segment: CustomerSegment;
  customer_since: string;
}

// ---- helpers -------------------------------------------------------------------------------

const usd = (cents: number): number => Math.round(cents) / 100;
const round = (v: number, dp: number): number => Math.round(v * 10 ** dp) / 10 ** dp;
const pct = (num: number, den: number): number | null =>
  den > 0 ? round((num / den) * 100, 2) : null;
const toCents = (dollars: number | undefined): number | null =>
  dollars === undefined ? null : Math.round(dollars * 100);

function assertPrincipal(principal: Principal | undefined): asserts principal is Principal {
  // Defence in depth: the data layer refuses to run without a well-formed identity.
  if (!principal || typeof principal.subject !== 'string' || !isRole(principal.role)) {
    throw new AppError(ErrorCode.Forbidden, 'A valid caller identity is required');
  }
}

function lookup<T extends Record<string, string>>(map: T, key: string, what: string): T[keyof T] {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    throw new AppError(ErrorCode.InvalidInput, `Unsupported ${what}`);
  }
  return map[key as keyof T];
}

function metricsFrom(row: AggregateRow) {
  return {
    activeLoanCount: row.active_count,
    totalOutstandingBalance: usd(row.active_balance_cents),
    weightedAverageRate: row.weighted_avg_rate === null ? null : round(row.weighted_avg_rate, 3),
    simpleAverageRate: row.simple_avg_rate === null ? null : round(row.simple_avg_rate, 3),
    delinquentLoanCount: row.delinquent_count,
    delinquencyRate: pct(row.delinquent_count, row.active_count),
    delinquentBalance: usd(row.delinquent_balance_cents),
    delinquentBalanceRate: pct(row.delinquent_balance_cents, row.active_balance_cents),
    defaultedLoanCount: row.default_count,
    defaultRate: pct(row.default_count, row.active_count),
  };
}

const THRESHOLDS = {
  delinquencyDays: DELINQUENCY_THRESHOLD_DAYS,
  defaultDays: DEFAULT_THRESHOLD_DAYS,
};

/**
 * SQLite implementation of the portfolio read model.
 *
 * The connection is opened read-only and with `query_only` set, so even a hypothetical injection
 * could not modify data. Statements are prepared once and reused.
 */
export class SqlitePortfolioRepository implements PortfolioRepository {
  private readonly db: Database.Database;
  private readonly searchStatements = new Map<string, Database.Statement>();

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (cause) {
      throw new Error(`Cannot open portfolio database at "${dbPath}". Run "npm run seed" first.`, {
        cause,
      });
    }
    this.db.pragma('query_only = ON');
  }

  async getDataAsOfDate(): Promise<string> {
    const row = this.db.prepare<[], { value: string }>(SQL_AS_OF).get();
    if (!row) throw new Error('portfolio_meta.as_of_date is missing; reseed the database');
    return row.value;
  }

  async getPortfolioSummary(
    principal: Principal,
    filter: { region?: Region; loanType?: LoanType; groupBy?: keyof typeof GROUP_EXPRESSIONS },
  ): Promise<PortfolioSummary> {
    assertPrincipal(principal);
    const params = {
      region: filter.region ?? null,
      loanType: filter.loanType ?? null,
      ...THRESHOLDS,
    };

    const totals = this.db.prepare<typeof params, AggregateRow>(SQL_SUMMARY_TOTALS).get(params);
    if (!totals) throw new Error('summary query returned no row');

    let groups: PortfolioSummary['groups'];
    if (filter.groupBy !== undefined) {
      const sql = lookup(SQL_SUMMARY_GROUPED, filter.groupBy, 'groupBy');
      groups = this.db
        .prepare<typeof params, AggregateRow & { group_key: string }>(sql)
        .all(params)
        .map((row) => ({ group: row.group_key, ...metricsFrom(row) }));
    }

    return {
      asOfDate: await this.getDataAsOfDate(),
      filters: { region: params.region, loanType: params.loanType },
      totals: {
        ...metricsFrom(totals),
        totalLoanCount: totals.total_count,
        paidOffLoanCount: totals.paid_off_count,
        totalOriginatedPrincipal: usd(totals.originated_cents),
      },
      ...(groups ? { groups, groupBy: filter.groupBy } : {}),
    };
  }

  async searchLoans(principal: Principal, query: SearchLoansQuery): Promise<SearchLoansResult> {
    assertPrincipal(principal);
    const pii = piiPolicyFor(principal);

    // Clamp again here: the data layer must not trust that callers validated input.
    const pageSize = Math.min(Math.max(1, Math.trunc(query.pageSize)), MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(query.page));
    const sortColumn = lookup(SORT_COLUMNS, query.sortBy, 'sortBy');
    const direction = lookup(SORT_DIRECTIONS, query.sortDirection, 'sortDirection');

    const filterParams = {
      statuses: query.status && query.status.length > 0 ? JSON.stringify(query.status) : null,
      region: query.region ?? null,
      loanType: query.loanType ?? null,
      riskGrade: query.riskGrade ?? null,
      minBalanceCents: toCents(query.minBalance),
      maxBalanceCents: toCents(query.maxBalance),
      originatedFrom: query.originatedFrom ?? null,
      originatedTo: query.originatedTo ?? null,
      minDaysPastDue: query.minDaysPastDue ?? null,
    };

    const total =
      this.db.prepare<typeof filterParams, { total: number }>(SQL_SEARCH_COUNT).get(filterParams)
        ?.total ?? 0;

    const cacheKey = `${sortColumn}|${direction}`;
    let stmt = this.searchStatements.get(cacheKey);
    if (!stmt) {
      stmt = this.db.prepare(searchPageSql(sortColumn, direction));
      this.searchStatements.set(cacheKey, stmt);
    }
    const rows = stmt.all({
      ...filterParams,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }) as SearchRow[];

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: rows.map((r) => ({
        loanRef: r.loan_ref,
        customerRef: r.customer_ref,
        customerName: pii.name(`${r.first_name} ${r.last_name}`),
        loanType: r.loan_type,
        region: r.region,
        status: r.status,
        currentBalance: usd(r.current_balance_cents),
        interestRate: r.interest_rate,
        originationDate: r.origination_date,
        daysPastDue: r.days_past_due,
        riskGrade: r.grade,
      })),
      page,
      pageSize,
      totalCount: total,
      totalPages,
      hasMore: page < totalPages,
      piiMasked: pii.masked,
    };
  }

  async getLoanDetails(
    principal: Principal,
    loanRef: string,
    options: { paymentLimit: number },
  ): Promise<LoanDetails | null> {
    assertPrincipal(principal);
    const pii = piiPolicyFor(principal);
    const limit = Math.min(Math.max(1, Math.trunc(options.paymentLimit)), MAX_PAYMENT_HISTORY);

    const loan = this.db.prepare<{ loanRef: string }, LoanRow>(SQL_LOAN_BY_REF).get({ loanRef });
    if (!loan) return null;

    const ratings = this.db
      .prepare<
        { loanId: number },
        { rating_date: string; grade: RiskGrade; probability_of_default: number; rated_by: string }
      >(SQL_LOAN_RATINGS)
      .all({ loanId: loan.id });
    const payments = this.db
      .prepare<
        { loanId: number; limit: number },
        {
          due_date: string;
          paid_date: string | null;
          amount_due_cents: number;
          amount_paid_cents: number;
          status: PaymentStatus;
          days_late: number | null;
        }
      >(SQL_LOAN_PAYMENTS)
      .all({ loanId: loan.id, limit });
    const summary = this.db
      .prepare<
        { loanId: number },
        { total: number; on_time: number; late: number; missed: number }
      >(SQL_LOAN_PAYMENT_SUMMARY)
      .get({ loanId: loan.id }) ?? { total: 0, on_time: 0, late: 0, missed: 0 };

    return {
      loan: {
        loanRef: loan.loan_ref,
        loanType: loan.loan_type,
        region: loan.region,
        status: loan.status,
        currentBalance: usd(loan.current_balance_cents),
        interestRate: loan.interest_rate,
        originationDate: loan.origination_date,
        daysPastDue: loan.days_past_due,
        principalAmount: usd(loan.principal_cents),
        termMonths: loan.term_months,
        maturityDate: loan.maturity_date,
        closedDate: loan.closed_date,
        monthlyPayment: usd(loan.monthly_payment_cents),
      },
      customer: {
        customerRef: loan.customer_ref,
        name: pii.name(`${loan.first_name} ${loan.last_name}`),
        email: pii.email(loan.email),
        segment: loan.segment,
        customerSince: loan.customer_since,
      },
      riskRatings: ratings.map((r) => ({
        ratingDate: r.rating_date,
        grade: r.grade,
        probabilityOfDefault: round(r.probability_of_default * 100, 2),
        ratedBy: r.rated_by,
      })),
      payments: payments.map((p) => ({
        dueDate: p.due_date,
        paidDate: p.paid_date,
        amountDue: usd(p.amount_due_cents),
        amountPaid: usd(p.amount_paid_cents),
        status: p.status,
        daysLate: p.days_late,
      })),
      paymentSummary: {
        totalScheduled: summary.total,
        paidOnTime: summary.on_time,
        paidLate: summary.late,
        missed: summary.missed,
        returned: payments.length,
      },
      piiMasked: pii.masked,
    };
  }

  async getDelinquencyTrend(
    principal: Principal,
    filter: { months: number; region?: Region; loanType?: LoanType },
  ): Promise<DelinquencyTrend> {
    assertPrincipal(principal);
    const months = Math.min(Math.max(1, Math.trunc(filter.months)), MAX_TREND_MONTHS);
    const asOf = await this.getDataAsOfDate();
    const params = {
      asOf,
      months,
      region: filter.region ?? null,
      loanType: filter.loanType ?? null,
      delinquencyDays: DELINQUENCY_THRESHOLD_DAYS,
    };
    const rows = this.db
      .prepare<
        typeof params,
        { month_end: string; active_loans: number; delinquent_loans: number }
      >(SQL_DELINQUENCY_TREND)
      .all(params);

    return {
      asOfDate: asOf,
      filters: { region: params.region, loanType: params.loanType },
      points: rows.map((r) => ({
        month: r.month_end.slice(0, 7),
        monthEnd: r.month_end,
        activeLoans: r.active_loans,
        delinquentLoans: r.delinquent_loans,
        delinquencyRate: pct(r.delinquent_loans, r.active_loans),
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}
