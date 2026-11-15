import type { Principal } from '../auth/principal.js';
import type { LoanType, Region } from '../schemas/domain.js';
import type {
  DelinquencyTrend,
  LoanDetails,
  PortfolioSummary,
  SearchLoansQuery,
  SearchLoansResult,
} from '../schemas/tools.js';

/**
 * Storage-agnostic read API over the loan portfolio.
 *
 * Contract every implementation (SQLite today; Postgres/SQL Server later) must honour:
 *  1. Every query is parameterized. No caller-supplied value is ever concatenated into SQL.
 *  2. Authorization is applied here, based on `principal`: customer PII is masked unless
 *     `Permissions.viewCustomerPii(principal)` is true. Tools cannot bypass this.
 *  3. Row limits are enforced here as well as at the schema layer (defence in depth).
 *  4. Methods are async so network-backed drivers fit without changing callers.
 */
export interface PortfolioRepository {
  getDataAsOfDate(): Promise<string>;

  getPortfolioSummary(
    principal: Principal,
    filter: {
      region?: Region | undefined;
      loanType?: LoanType | undefined;
      groupBy?: 'region' | 'loan_type' | 'risk_grade' | undefined;
    },
  ): Promise<PortfolioSummary>;

  searchLoans(principal: Principal, query: SearchLoansQuery): Promise<SearchLoansResult>;

  /** Returns `null` when the loan does not exist. */
  getLoanDetails(
    principal: Principal,
    loanRef: string,
    options: { paymentLimit: number },
  ): Promise<LoanDetails | null>;

  getDelinquencyTrend(
    principal: Principal,
    filter: { months: number; region?: Region | undefined; loanType?: LoanType | undefined },
  ): Promise<DelinquencyTrend>;

  close(): void;
}

export type AuditOutcome =
  'success' | 'invalid_input' | 'denied' | 'not_found' | 'error' | 'timeout';

/** What was accessed: a tool call, a resource read, or a prompt read. */
export type AuditKind = 'tool' | 'resource' | 'prompt';

export interface AuditEntry {
  timestamp: string;
  correlationId: string;
  subject: string;
  role: string;
  authMethod: string;
  kind: AuditKind;
  /** Tool name, resource URI or prompt name, depending on `kind`. */
  name: string;
  /** Validated (post-Zod) arguments. For rejected input, a size-capped copy of the raw input. */
  arguments: unknown;
  outcome: AuditOutcome;
  errorCode: string | null;
  rowCount: number | null;
  durationMs: number;
}

/** Append-only audit sink. Implementations must never allow updates or deletes. */
export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
  close(): void;
}
