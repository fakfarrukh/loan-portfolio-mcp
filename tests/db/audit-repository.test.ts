import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_AUDIT_ARGS_BYTES,
  serializeAuditArgs,
  SqliteAuditRepository,
  withBusyRetry,
} from '../../src/db/sqlite/audit-repository.js';

describe('withBusyRetry (shared audit file, concurrent startup)', () => {
  const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

  it('retries while the file is busy, then succeeds', () => {
    let calls = 0;
    withBusyRetry(() => {
      calls++;
      if (calls < 3) throw busy();
    });
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt and rethrows the busy error', () => {
    let calls = 0;
    expect(() => {
      withBusyRetry(() => {
        calls++;
        throw busy();
      }, 2);
    }).toThrow(/database is locked/);
    expect(calls).toBe(2);
  });

  it('does not retry other errors', () => {
    let calls = 0;
    expect(() => {
      withBusyRetry(() => {
        calls++;
        throw new Error('disk I/O error');
      });
    }).toThrow(/disk I\/O/);
    expect(calls).toBe(1);
  });
});

describe('SqliteAuditRepository', () => {
  const audit = new SqliteAuditRepository(':memory:');
  afterAll(() => {
    audit.close();
  });

  const entry = {
    timestamp: new Date().toISOString(),
    correlationId: 'c-1',
    subject: 'alice',
    role: 'analyst',
    authMethod: 'jwt',
    kind: 'tool' as const,
    name: 'search_loans',
    arguments: { region: 'West' },
    outcome: 'success' as const,
    errorCode: null,
    rowCount: 3,
    durationMs: 1.234,
  };

  it('records entries', async () => {
    await audit.record(entry);
    const [row] = audit.recent(1);
    expect(row).toMatchObject({
      subject: 'alice',
      kind: 'tool',
      name: 'search_loans',
      row_count: 3,
    });
    expect(JSON.parse(row!.arguments_json as string)).toEqual({ region: 'West' });
  });

  it('is append-only: updates and deletes are rejected', () => {
    const db = audit.rawConnectionForTests;
    expect(() => db.prepare("UPDATE audit_log SET subject = 'mallory'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('upgrades a v1.0 audit store (tool column, no kind) without losing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-migrate-'));
    const path = join(dir, 'audit.db');
    try {
      const old = new Database(path);
      old.exec(`CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, correlation_id TEXT NOT NULL,
        subject TEXT NOT NULL, role TEXT NOT NULL, auth_method TEXT NOT NULL, tool TEXT NOT NULL,
        arguments_json TEXT NOT NULL, outcome TEXT NOT NULL, error_code TEXT, row_count INTEGER,
        duration_ms REAL NOT NULL)`);
      old
        .prepare(
          `INSERT INTO audit_log (ts, correlation_id, subject, role, auth_method, tool,
             arguments_json, outcome, duration_ms)
           VALUES ('2026-01-01T00:00:00Z', 'old', 'carol', 'analyst', 'stdio', 'explain_metric',
             '{}', 'success', 1)`,
        )
        .run();
      old.close();

      const upgraded = new SqliteAuditRepository(path);
      try {
        expect(upgraded.recent(1)[0]).toMatchObject({
          subject: 'carol',
          kind: 'tool',
          name: 'explain_metric',
        });
        void upgraded.record({ ...entry, kind: 'prompt', name: 'monthly_portfolio_review' });
        expect(upgraded.recent(1)[0]).toMatchObject({ kind: 'prompt' });
        expect(() => upgraded.rawConnectionForTests.prepare('DELETE FROM audit_log').run()).toThrow(
          /append-only/,
        );
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      audit.rawConnectionForTests
        .prepare(
          `INSERT INTO audit_log (ts, correlation_id, subject, role, auth_method, kind, name,
             arguments_json, outcome, duration_ms)
           VALUES ('t', 'c', 's', 'r', 'a', 'shell', 'n', '{}', 'success', 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('caps the size of stored arguments', () => {
    const json = serializeAuditArgs({ blob: 'x'.repeat(100_000) });
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_AUDIT_ARGS_BYTES);
    expect(JSON.parse(json)).toMatchObject({ truncated: true });
  });
});
