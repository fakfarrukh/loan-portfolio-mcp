import {
  CUSTOMER_SEGMENTS,
  LOAN_STATUSES,
  LOAN_TYPES,
  PAYMENT_STATUSES,
  REGIONS,
  RISK_GRADES,
} from '../../schemas/domain.js';

/** Renders a CHECK(col IN (...)) list from a compile-time constant (never from user input). */
const oneOf = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/**
 * Portfolio schema. Money is stored as INTEGER cents to avoid floating-point drift;
 * dates are ISO-8601 TEXT, which sorts and compares correctly in SQLite.
 */
export const PORTFOLIO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portfolio_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY,
  customer_ref    TEXT NOT NULL UNIQUE,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  segment         TEXT NOT NULL CHECK (segment IN (${oneOf(CUSTOMER_SEGMENTS)})),
  region          TEXT NOT NULL CHECK (region IN (${oneOf(REGIONS)})),
  customer_since  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id                   INTEGER PRIMARY KEY,
  loan_ref             TEXT NOT NULL UNIQUE,
  customer_id          INTEGER NOT NULL REFERENCES customers(id),
  loan_type            TEXT NOT NULL CHECK (loan_type IN (${oneOf(LOAN_TYPES)})),
  region               TEXT NOT NULL CHECK (region IN (${oneOf(REGIONS)})),
  principal_cents      INTEGER NOT NULL CHECK (principal_cents > 0),
  current_balance_cents INTEGER NOT NULL CHECK (current_balance_cents >= 0),
  interest_rate        REAL NOT NULL CHECK (interest_rate > 0 AND interest_rate < 40),
  term_months          INTEGER NOT NULL CHECK (term_months > 0),
  monthly_payment_cents INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (${oneOf(LOAN_STATUSES)})),
  days_past_due        INTEGER NOT NULL DEFAULT 0 CHECK (days_past_due >= 0),
  origination_date     TEXT NOT NULL,
  maturity_date        TEXT NOT NULL,
  closed_date          TEXT
);
CREATE INDEX IF NOT EXISTS ix_loans_region_type   ON loans(region, loan_type);
CREATE INDEX IF NOT EXISTS ix_loans_status        ON loans(status);
CREATE INDEX IF NOT EXISTS ix_loans_origination   ON loans(origination_date);
CREATE INDEX IF NOT EXISTS ix_loans_customer      ON loans(customer_id);

CREATE TABLE IF NOT EXISTS payments (
  id                INTEGER PRIMARY KEY,
  loan_id           INTEGER NOT NULL REFERENCES loans(id),
  due_date          TEXT NOT NULL,
  paid_date         TEXT,
  amount_due_cents  INTEGER NOT NULL,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN (${oneOf(PAYMENT_STATUSES)})),
  days_late         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_payments_loan_due ON payments(loan_id, due_date);

CREATE TABLE IF NOT EXISTS risk_ratings (
  id                    INTEGER PRIMARY KEY,
  loan_id               INTEGER NOT NULL REFERENCES loans(id),
  rating_date           TEXT NOT NULL,
  grade                 TEXT NOT NULL CHECK (grade IN (${oneOf(RISK_GRADES)})),
  probability_of_default REAL NOT NULL CHECK (probability_of_default BETWEEN 0 AND 1),
  rated_by              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_risk_loan_date ON risk_ratings(loan_id, rating_date);

-- Latest rating per loan; used by search and grouping.
CREATE VIEW IF NOT EXISTS v_loan_latest_rating AS
SELECT r.loan_id, r.grade, r.probability_of_default, r.rating_date
FROM risk_ratings r
WHERE r.id = (
  SELECT r2.id FROM risk_ratings r2
  WHERE r2.loan_id = r.loan_id
  ORDER BY r2.rating_date DESC, r2.id DESC
  LIMIT 1
);
`;

/**
 * Audit store. Kept in a separate database file so the portfolio connection can be opened
 * read-only, and so the audit trail can be shipped/retained independently of business data.
 * Triggers make the table append-only even for code that holds a writable handle.
 */
export const AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY,
  ts              TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  subject         TEXT NOT NULL,
  role            TEXT NOT NULL,
  auth_method     TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'tool' CHECK (kind IN ('tool', 'resource', 'prompt')),
  name            TEXT NOT NULL,
  arguments_json  TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  error_code      TEXT,
  row_count       INTEGER,
  duration_ms     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_ts      ON audit_log(ts);
CREATE INDEX IF NOT EXISTS ix_audit_subject ON audit_log(subject, ts);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;
