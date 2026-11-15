import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuditRepository, PortfolioRepository } from '../../src/db/repository.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { defineTool } from '../../src/tools/types.js';
import { admin, analyst } from '../helpers.js';
import { createHarness, expectErr, expectOk, makeTracer, silentLogger } from './harness.js';

/** A repository whose every method fails like a real driver would (with internal details). */
const exploding = new Proxy({} as PortfolioRepository, {
  get: (_t, prop) =>
    prop === 'close'
      ? () => undefined
      : () =>
          Promise.reject(
            new Error(
              'SQLITE_CORRUPT: database disk image is malformed at /srv/secret/portfolio.db',
            ),
          ),
});

describe('ToolExecutor guardrails', () => {
  const h = createHarness();
  afterAll(() => {
    h.close();
  });

  it('rejects unauthenticated calls and audits them as denied', async () => {
    const e = expectErr(await h.call('get_portfolio_summary', {}, undefined));
    expect(e.code).toBe('UNAUTHENTICATED');
    expect(h.audit.recent(1)[0]).toMatchObject({ subject: 'anonymous', outcome: 'denied' });
  });

  it('rejects unknown tools', async () => {
    const e = expectErr(await h.call('drop_tables', {}, admin));
    expect(e.code).toBe('UNKNOWN_TOOL');
  });

  it('rejects oversized input before parsing it', async () => {
    const e = expectErr(
      await h.call('search_loans', { region: 'West', junk: 'x'.repeat(10_000) }, analyst),
    );
    expect(e.code).toBe('INPUT_TOO_LARGE');
    const row = h.audit.recent(1)[0]!;
    expect(row.outcome).toBe('invalid_input');
    expect(JSON.parse(row.arguments_json as string)).toMatchObject({ omitted: true });
  });

  it('attaches a correlation id to every error', async () => {
    const e = expectErr(await h.call('search_loans', { pageSize: 999 }, analyst));
    expect(e.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.audit.recent(1)[0]!.correlation_id).toBe(e.correlationId);
  });

  it('enforces per-tool role restrictions', async () => {
    const adminOnly = defineTool({
      name: 'admin_only',
      title: 'Admin only',
      description: 'test',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      allowedRoles: ['admin'],
      handler: () => Promise.resolve({ ok: true }),
      rowCount: () => 1,
    });
    const hx = createHarness({ tools: [adminOnly] });
    try {
      expect(expectErr(await hx.call('admin_only', {}, analyst)).code).toBe('FORBIDDEN');
      expect(expectOk(await hx.call('admin_only', {}, admin))).toEqual({ ok: true });
      expect(hx.audit.recent(2)[1]).toMatchObject({ outcome: 'denied', error_code: 'FORBIDDEN' });
    } finally {
      hx.close();
    }
  });
});

describe('safe errors', () => {
  it('never returns stack traces, SQL or file paths to the client', async () => {
    const h = createHarness({ repo: exploding });
    try {
      const e = expectErr(await h.call('get_portfolio_summary', {}, analyst));
      expect(e.code).toBe('INTERNAL_ERROR');
      const serialized = JSON.stringify(e);
      expect(serialized).not.toMatch(/SQLITE|secret|portfolio\.db|at .*\.ts|Error:/);
      expect(h.audit.recent(1)[0]).toMatchObject({
        outcome: 'error',
        error_code: 'INTERNAL_ERROR',
      });
    } finally {
      h.close();
    }
  });

  it('withholds output that violates the output schema (allow-list)', async () => {
    const leaky = defineTool({
      name: 'leaky',
      title: 'Leaky',
      description: 'test',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ loanRef: z.string() }),
      allowedRoles: ['analyst', 'admin'],
      handler: () => Promise.resolve({ loanRef: 'LN-000001', ssn: '000-00-0000' } as never),
      rowCount: () => 1,
    });
    const h = createHarness({ tools: [leaky] });
    try {
      const e = expectErr(await h.call('leaky', {}, admin));
      expect(e.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(e)).not.toContain('000-00-0000');
    } finally {
      h.close();
    }
  });
});

describe('timeouts', () => {
  it('returns TIMEOUT when a tool exceeds the limit', async () => {
    const slow = new Proxy({} as PortfolioRepository, {
      get: (_t, prop) => (prop === 'close' ? () => undefined : () => new Promise(() => undefined)),
    });
    const h = createHarness({ repo: slow, timeoutMs: 100 });
    try {
      const started = Date.now();
      const e = expectErr(await h.call('get_portfolio_summary', {}, analyst));
      expect(e.code).toBe('TIMEOUT');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(h.audit.recent(1)[0]).toMatchObject({ outcome: 'timeout' });
    } finally {
      h.close();
    }
  });

  it('stops when the client cancels the request', async () => {
    const slow = new Proxy({} as PortfolioRepository, {
      get: (_t, prop) => (prop === 'close' ? () => undefined : () => new Promise(() => undefined)),
    });
    const h = createHarness({ repo: slow, timeoutMs: 10_000 });
    try {
      const ac = new AbortController();
      setTimeout(() => {
        ac.abort();
      }, 50);
      const r = await h.executor.execute('get_portfolio_summary', {}, analyst, ac.signal);
      expect(expectErr(r).code).toBe('TIMEOUT');
    } finally {
      h.close();
    }
  });
});

describe('audit failure', () => {
  it('fails closed: no audit record, no data', async () => {
    const h = createHarness();
    const brokenAudit: AuditRepository = {
      record: () => Promise.reject(new Error('disk full')),
      close: () => undefined,
    };
    const executor = new ToolExecutor({
      tools: ALL_TOOLS,
      repo: h.repo,
      audit: brokenAudit,
      tracer: makeTracer().tracer,
      logger: silentLogger,
      timeoutMs: 5_000,
      maxInputBytes: 4_096,
    });
    try {
      const r = await executor.execute('search_loans', {}, admin);
      expect(expectErr(r).code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(r)).not.toContain('disk full');

      // Resource and prompt reads follow the same rule.
      const read = await executor.runAudited('resource', 'portfolio://x', {}, admin, () =>
        Promise.resolve('the data'),
      );
      expect(read.ok).toBe(false);
      expect(JSON.stringify(read)).not.toContain('the data');
    } finally {
      h.close();
    }
  });
});

describe('tracing', () => {
  it('emits one span per tool call with identity, outcome and row count', async () => {
    const h = createHarness();
    try {
      await h.call('search_loans', { pageSize: 3 }, analyst);
      await h.call('search_loans', { pageSize: 500 }, analyst);
      const [ok, bad] = h.spans.getFinishedSpans();
      expect(ok!.name).toBe('mcp.tool search_loans');
      expect(ok!.attributes).toMatchObject({
        'mcp.tool.name': 'search_loans',
        'enduser.id': analyst.subject,
        'enduser.role': 'analyst',
        'mcp.tool.outcome': 'success',
        'mcp.tool.row_count': 3,
      });
      expect(bad!.attributes['mcp.tool.outcome']).toBe('invalid_input');
      expect(bad!.status.code).toBe(2); // SpanStatusCode.ERROR
    } finally {
      h.close();
    }
  });
});
