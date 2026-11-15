import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { pino } from 'pino';
import type { Principal } from '../../src/auth/principal.js';
import type { PortfolioRepository } from '../../src/db/repository.js';
import { SqliteAuditRepository } from '../../src/db/sqlite/audit-repository.js';
import { SqlitePortfolioRepository } from '../../src/db/sqlite/portfolio-repository.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { createTestDb, type TestDb } from '../helpers.js';

export const silentLogger = pino({ level: 'silent' });

export interface Harness {
  db: TestDb;
  repo: SqlitePortfolioRepository;
  audit: SqliteAuditRepository;
  executor: ToolExecutor;
  spans: InMemorySpanExporter;
  call: (tool: string, args: unknown, principal?: Principal) => ReturnType<ToolExecutor['execute']>;
  close: () => void;
}

export function makeTracer() {
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  return { spans, tracer: provider.getTracer('test') };
}

export function createHarness(
  opts: {
    tools?: readonly ToolDefinition[];
    repo?: PortfolioRepository;
    timeoutMs?: number;
    maxInputBytes?: number;
  } = {},
): Harness {
  const db = createTestDb();
  const repo = new SqlitePortfolioRepository(db.dbPath);
  const audit = new SqliteAuditRepository(':memory:');
  const { spans, tracer } = makeTracer();
  const executor = new ToolExecutor({
    tools: opts.tools ?? ALL_TOOLS,
    repo: opts.repo ?? repo,
    audit,
    tracer,
    logger: silentLogger,
    timeoutMs: opts.timeoutMs ?? 5_000,
    maxInputBytes: opts.maxInputBytes ?? 4_096,
  });
  return {
    db,
    repo,
    audit,
    executor,
    spans,
    call: (tool, args, principal) => executor.execute(tool, args, principal),
    close: () => {
      repo.close();
      audit.close();
      db.cleanup();
    },
  };
}

/** Narrowing helpers that make test failures readable. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- deliberate test-only cast
export function expectOk<T = Record<string, unknown>>(
  r: Awaited<ReturnType<ToolExecutor['execute']>>,
): T {
  if (!r.ok) throw new Error(`Expected success, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

export function expectErr(r: Awaited<ReturnType<ToolExecutor['execute']>>) {
  if (r.ok) throw new Error(`Expected error, got ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.error;
}

// Keep the global tracer API untouched by tests.
export const noopTracer = trace.getTracer('noop');
