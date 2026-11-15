import { trace, type Tracer } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { Writable } from 'node:stream';

export const TRACER_NAME = 'loan-portfolio-mcp';

/**
 * Console exporter that writes to stderr instead of stdout.
 * The stock ConsoleSpanExporter uses console.dir (stdout), which would corrupt the stdio
 * MCP transport, so we redirect it.
 */
class StderrSpanExporter extends ConsoleSpanExporter {
  constructor(private readonly out: Writable = process.stderr) {
    super();
  }

  override export(
    spans: Parameters<ConsoleSpanExporter['export']>[0],
    done: Parameters<ConsoleSpanExporter['export']>[1],
  ): void {
    for (const s of spans) {
      const ctx = s.spanContext();
      this.out.write(
        JSON.stringify({
          otel: 'span',
          name: s.name,
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          durationMs: s.duration[0] * 1e3 + s.duration[1] / 1e6,
          status: s.status,
          attributes: s.attributes,
        }) + '\n',
      );
    }
    done({ code: ExportResultCode.SUCCESS });
  }
}

export interface TelemetryHandle {
  tracer: Tracer;
  shutdown: () => Promise<void>;
}

/**
 * Initialises tracing. Swap the exporter for an OTLP exporter in production
 * (e.g. @opentelemetry/exporter-trace-otlp-http pointed at a collector) — tool code is unaffected.
 */
export function initTelemetry(opts: {
  serviceName: string;
  serviceVersion?: string;
  exporter: 'console' | 'none';
  customExporter?: SpanExporter;
}): TelemetryHandle {
  const processors: SpanProcessor[] = [];
  const exporter =
    opts.customExporter ?? (opts.exporter === 'console' ? new StderrSpanExporter() : undefined);
  if (exporter) processors.push(new BatchSpanProcessor(exporter));

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '1.0.0',
    }),
    spanProcessors: processors,
  });
  provider.register();

  return {
    tracer: trace.getTracer(TRACER_NAME),
    shutdown: () => provider.shutdown(),
  };
}
