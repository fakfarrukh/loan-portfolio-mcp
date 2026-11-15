import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import type {
  AuditKind,
  AuditOutcome,
  AuditRepository,
  PortfolioRepository,
} from '../db/repository.js';
import { AppError, ErrorCode, toSafeError, type SafeError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ToolDefinition } from './types.js';

export type ToolResult =
  { ok: true; data: unknown; correlationId: string } | { ok: false; error: SafeError };

export type AuditedResult<T> = { ok: true; value: T } | { ok: false; error: SafeError };

export interface ToolExecutorOptions {
  tools: readonly ToolDefinition[];
  repo: PortfolioRepository;
  audit: AuditRepository | null;
  tracer: Tracer;
  logger: Logger;
  timeoutMs: number;
  maxInputBytes: number;
}

const OUTCOME_BY_CODE: Partial<Record<ErrorCode, AuditOutcome>> = {
  [ErrorCode.InvalidInput]: 'invalid_input',
  [ErrorCode.InputTooLarge]: 'invalid_input',
  [ErrorCode.UnknownTool]: 'invalid_input',
  [ErrorCode.Forbidden]: 'denied',
  [ErrorCode.Unauthenticated]: 'denied',
  [ErrorCode.NotFound]: 'not_found',
  [ErrorCode.Timeout]: 'timeout',
};

/** Validation issues reduced to safe, LLM-actionable details (no stack, no internals). */
function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 10).map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

/**
 * Races `work` against a timeout and an optional caller signal.
 *
 * Note: SQLite calls are synchronous, so a timeout cannot interrupt a query already running on
 * the event loop; it bounds total tool latency and protects against slow async drivers. Query cost
 * is bounded separately by indexes and LIMITs (see DECISIONS.md).
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppError(ErrorCode.Timeout, `The request exceeded the ${timeoutMs} ms limit`));
    }, timeoutMs);
    parent?.addEventListener(
      'abort',
      () => {
        reject(new AppError(ErrorCode.Timeout, 'The request was cancelled by the client'));
      },
      { once: true },
    );
  });
  // A late cancellation after `work` settled must not surface as an unhandled rejection.
  timeout.catch(() => undefined);
  try {
    return await Promise.race([work(signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transport-independent tool runner. Every call — successful or not — goes through the same
 * sequence: identify → size-check → validate → authorize → trace → execute with timeout →
 * validate output → audit → map errors.
 */
export class ToolExecutor {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(private readonly opts: ToolExecutorOptions) {
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
  }

  list(): readonly ToolDefinition[] {
    return this.opts.tools;
  }

  async execute(
    toolName: string,
    rawArgs: unknown,
    principal: Principal | undefined,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const correlationId = randomUUID();
    const started = performance.now();
    const { tracer, logger } = this.opts;

    return tracer.startActiveSpan(`mcp.tool ${toolName}`, async (span): Promise<ToolResult> => {
      span.setAttributes({
        'mcp.tool.name': toolName,
        'mcp.correlation_id': correlationId,
        'enduser.id': principal?.subject ?? 'anonymous',
        'enduser.role': principal?.role ?? 'none',
      });

      let auditArgs: unknown = rawArgs;
      let rowCount: number | null = null;
      let outcome: AuditOutcome = 'success';
      let errorCode: string | null = null;
      let result: ToolResult;

      try {
        if (!principal) throw new AppError(ErrorCode.Unauthenticated, 'Authentication required');

        const tool = this.tools.get(toolName);
        if (!tool) throw new AppError(ErrorCode.UnknownTool, `Unknown tool: ${toolName}`);

        const size = Buffer.byteLength(JSON.stringify(rawArgs ?? {}), 'utf8');
        if (size > this.opts.maxInputBytes) {
          auditArgs = { omitted: true, bytes: size };
          throw new AppError(
            ErrorCode.InputTooLarge,
            `Arguments are ${size} bytes; the limit is ${this.opts.maxInputBytes} bytes`,
          );
        }

        const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
        if (!parsed.success) {
          throw new AppError(ErrorCode.InvalidInput, 'Invalid arguments', issuesOf(parsed.error));
        }
        auditArgs = parsed.data;

        if (!tool.allowedRoles.includes(principal.role)) {
          throw new AppError(
            ErrorCode.Forbidden,
            `Role "${principal.role}" may not call ${toolName}`,
          );
        }

        const raw = await withTimeout(
          (s) =>
            tool.handler(
              parsed.data,
              { principal, correlationId, signal: s },
              { repo: this.opts.repo },
            ),
          this.opts.timeoutMs,
          signal,
        );

        // Output contract doubles as an allow-list: unexpected fields are rejected, not leaked.
        const out = tool.outputSchema.safeParse(raw);
        if (!out.success) {
          logger.error(
            { correlationId, tool: toolName, issues: issuesOf(out.error) },
            'Tool output failed schema validation',
          );
          throw new Error('output validation failed');
        }
        rowCount = tool.rowCount(out.data);
        span.setAttribute('mcp.tool.row_count', rowCount);
        span.setStatus({ code: SpanStatusCode.OK });
        result = { ok: true, data: out.data, correlationId };
      } catch (err) {
        const safe = toSafeError(err, correlationId);
        outcome = OUTCOME_BY_CODE[safe.code] ?? 'error';
        errorCode = safe.code;
        span.setStatus({ code: SpanStatusCode.ERROR, message: safe.code });
        if (!(err instanceof AppError)) {
          // Full detail stays server-side, keyed by correlationId.
          logger.error({ correlationId, tool: toolName, err }, 'Unhandled tool error');
          span.recordException(err instanceof Error ? err : new Error(String(err)));
        }
        result = { ok: false, error: safe };
      }

      const auditError = await this.finish(span, {
        kind: 'tool',
        name: toolName,
        principal,
        correlationId,
        started,
        auditArgs,
        outcome,
        errorCode,
        rowCount,
      });
      return auditError ? { ok: false, error: auditError } : result;
    });
  }

  /**
   * Runs a resource or prompt read with the same identity check, tracing, auditing and
   * fail-closed behaviour as a tool call. `work` validates its own input and may replace
   * `audit.args` with the validated form; it signals failure by throwing an AppError.
   */
  async runAudited<T>(
    kind: Exclude<AuditKind, 'tool'>,
    name: string,
    rawArgs: unknown,
    principal: Principal | undefined,
    work: (principal: Principal, audit: { args: unknown }) => Promise<T>,
  ): Promise<AuditedResult<T>> {
    const correlationId = randomUUID();
    const started = performance.now();

    return this.opts.tracer.startActiveSpan(
      `mcp.${kind} ${name}`,
      async (span): Promise<AuditedResult<T>> => {
        span.setAttributes({
          [`mcp.${kind}.name`]: name,
          'mcp.correlation_id': correlationId,
          'enduser.id': principal?.subject ?? 'anonymous',
          'enduser.role': principal?.role ?? 'none',
        });
        const audit = { args: rawArgs };
        let outcome: AuditOutcome = 'success';
        let errorCode: string | null = null;
        let result: AuditedResult<T>;

        try {
          if (!principal) throw new AppError(ErrorCode.Unauthenticated, 'Authentication required');
          result = { ok: true, value: await work(principal, audit) };
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          const safe = toSafeError(err, correlationId);
          outcome = OUTCOME_BY_CODE[safe.code] ?? 'error';
          errorCode = safe.code;
          span.setStatus({ code: SpanStatusCode.ERROR, message: safe.code });
          if (!(err instanceof AppError)) {
            this.opts.logger.error({ correlationId, kind, name, err }, `Unhandled ${kind} error`);
          }
          result = { ok: false, error: safe };
        }

        const auditError = await this.finish(span, {
          kind,
          name,
          principal,
          correlationId,
          started,
          auditArgs: audit.args,
          outcome,
          errorCode,
          rowCount: outcome === 'success' ? 1 : null,
        });
        return auditError ? { ok: false, error: auditError } : result;
      },
    );
  }

  /**
   * Common tail for every audited operation: write the audit record, log, close the span.
   * Returns a safe error when the audit write fails, in which case the caller must withhold
   * the result (fail closed: if we cannot record who saw the data, we do not return it).
   */
  private async finish(
    span: Span,
    r: {
      kind: AuditKind;
      name: string;
      principal: Principal | undefined;
      correlationId: string;
      started: number;
      auditArgs: unknown;
      outcome: AuditOutcome;
      errorCode: string | null;
      rowCount: number | null;
    },
  ): Promise<SafeError | null> {
    const { logger } = this.opts;
    const durationMs = performance.now() - r.started;
    span.setAttribute(`mcp.${r.kind}.outcome`, r.outcome);
    let auditError: SafeError | null = null;

    try {
      await this.opts.audit?.record({
        timestamp: new Date().toISOString(),
        correlationId: r.correlationId,
        subject: r.principal?.subject ?? 'anonymous',
        role: r.principal?.role ?? 'none',
        authMethod: r.principal?.authMethod ?? 'none',
        kind: r.kind,
        name: r.name,
        arguments: r.auditArgs,
        outcome: r.outcome,
        errorCode: r.errorCode,
        rowCount: r.rowCount,
        durationMs,
      });
    } catch (err) {
      logger.error(
        { correlationId: r.correlationId, err },
        'Audit write failed; withholding result',
      );
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'AUDIT_FAILED' });
      auditError = toSafeError(err, r.correlationId);
    }

    logger.info(
      {
        correlationId: r.correlationId,
        kind: r.kind,
        name: r.name,
        subject: r.principal?.subject,
        role: r.principal?.role,
        outcome: auditError ? 'error' : r.outcome,
        errorCode: auditError ? auditError.code : r.errorCode,
        rowCount: r.rowCount,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      `${r.kind} access`,
    );
    span.end();
    return auditError;
  }
}
