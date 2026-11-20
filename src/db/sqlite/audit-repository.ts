import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry, AuditRepository } from '../repository.js';
import { AUDIT_SCHEMA_SQL } from './schema.js';

/** Upper bound on stored argument JSON, so a hostile client cannot bloat the audit store. */
export const MAX_AUDIT_ARGS_BYTES = 4_096;

/** How long a write waits for another process's lock before failing. */
export const AUDIT_BUSY_TIMEOUT_MS = 5_000;
const SETUP_ATTEMPTS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs one-time setup, retrying with backoff while another process holds the file. */
export function withBusyRetry(setup: () => void, attempts = SETUP_ATTEMPTS): void {
  for (let attempt = 1; ; attempt++) {
    try {
      setup();
      return;
    } catch (err) {
      const busy = (err as { code?: string }).code?.startsWith('SQLITE_BUSY') === true;
      if (!busy || attempt >= attempts) throw err;
      sleepSync(Math.min(25 * 2 ** attempt, 1_000) + Math.random() * 25);
    }
  }
}

/** JSON.stringify's declared type omits that it returns undefined for functions and symbols. */
function stringifyOrUndefined(value: unknown): string | undefined {
  return JSON.stringify(value);
}

export function serializeAuditArgs(args: unknown): string {
  let json: string;
  try {
    json = stringifyOrUndefined(args ?? null) ?? 'null';
  } catch {
    json = '"[unserializable]"';
  }
  if (Buffer.byteLength(json, 'utf8') <= MAX_AUDIT_ARGS_BYTES) return json;
  return JSON.stringify({
    truncated: true,
    preview: json.slice(0, MAX_AUDIT_ARGS_BYTES / 2),
  });
}

/**
 * Writes audit records to their own SQLite database. Append-only is enforced by triggers
 * (see AUDIT_SCHEMA_SQL), not just by convention.
 */
export class SqliteAuditRepository implements AuditRepository {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { timeout: AUDIT_BUSY_TIMEOUT_MS });
    withBusyRetry(() => {
      // Several server processes may share one audit file (e.g. an analyst and an admin entry in
      // Claude Desktop, started together). Creating the file and switching it to WAL can return
      // SQLITE_BUSY at once, without waiting on the busy timeout, so setup is retried.
      if (this.db.pragma('journal_mode', { simple: true }) !== 'wal') {
        this.db.pragma('journal_mode = WAL');
      }
      this.db.exec(AUDIT_SCHEMA_SQL);
      this.migrate();
    });
    this.insert = this.db.prepare(
      `INSERT INTO audit_log (ts, correlation_id, subject, role, auth_method, kind, name,
                              arguments_json, outcome, error_code, row_count, duration_ms)
       VALUES (@ts, @correlationId, @subject, @role, @authMethod, @kind, @name,
               @argumentsJson, @outcome, @errorCode, @rowCount, @durationMs)`,
    );
  }

  /**
   * Upgrades audit stores created by v1.0, which only audited tools (column `tool`, no `kind`).
   * Existing rows are kept unchanged and labelled as tool calls. Schema changes do not fire the
   * append-only UPDATE/DELETE triggers.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (columns.has('tool') && !columns.has('name')) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE audit_log RENAME COLUMN tool TO name');
        this.db.exec(
          "ALTER TABLE audit_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool' CHECK (kind IN ('tool', 'resource', 'prompt'))",
        );
      })();
    }
  }

  record(entry: AuditEntry): Promise<void> {
    this.insert.run({
      ts: entry.timestamp,
      correlationId: entry.correlationId,
      subject: entry.subject,
      role: entry.role,
      authMethod: entry.authMethod,
      kind: entry.kind,
      name: entry.name,
      argumentsJson: serializeAuditArgs(entry.arguments),
      outcome: entry.outcome,
      errorCode: entry.errorCode,
      rowCount: entry.rowCount,
      durationMs: Math.round(entry.durationMs * 100) / 100,
    });
    return Promise.resolve();
  }

  /** Read access for tests and admin tooling. Not exposed as an MCP tool. */
  recent(limit = 50): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(1, limit), 1000)) as Record<string, unknown>[];
  }

  /** Exposed for tests that prove the append-only triggers work. */
  get rawConnectionForTests(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
