import type { Tracer } from '@opentelemetry/api';
import type { AppConfig } from './config.js';
import type { AuditRepository, PortfolioRepository } from './db/repository.js';
import { SqliteAuditRepository } from './db/sqlite/audit-repository.js';
import { SqlitePortfolioRepository } from './db/sqlite/portfolio-repository.js';
import { createLogger, type Logger } from './logger.js';
import { initTelemetry } from './telemetry.js';
import { ToolExecutor } from './tools/executor.js';
import { ALL_TOOLS } from './tools/index.js';

export interface AppContainer {
  config: AppConfig;
  logger: Logger;
  tracer: Tracer;
  repo: PortfolioRepository;
  audit: AuditRepository | null;
  executor: ToolExecutor;
  close: () => Promise<void>;
}

/**
 * Composition root: the only place that knows concrete implementations.
 * Swapping SQLite for Postgres means changing the two constructors below — nothing else.
 */
export function createApp(config: AppConfig, overrides: { logger?: Logger } = {}): AppContainer {
  const logger = overrides.logger ?? createLogger(config.LOG_LEVEL);
  const telemetry = initTelemetry({
    serviceName: config.OTEL_SERVICE_NAME,
    exporter: config.OTEL_TRACES_EXPORTER,
  });
  const repo = new SqlitePortfolioRepository(config.DB_PATH);
  const audit = config.AUDIT_ENABLED ? new SqliteAuditRepository(config.AUDIT_DB_PATH) : null;

  const executor = new ToolExecutor({
    tools: ALL_TOOLS,
    repo,
    audit,
    tracer: telemetry.tracer,
    logger,
    timeoutMs: config.TOOL_TIMEOUT_MS,
    maxInputBytes: config.MAX_TOOL_INPUT_BYTES,
  });

  return {
    config,
    logger,
    tracer: telemetry.tracer,
    repo,
    audit,
    executor,
    close: async () => {
      repo.close();
      audit?.close();
      await telemetry.shutdown();
    },
  };
}
