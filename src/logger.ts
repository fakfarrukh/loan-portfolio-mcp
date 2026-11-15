import { pino, type Logger } from 'pino';

/**
 * Structured JSON logger.
 *
 * Logs go to **stderr** (fd 2): with the stdio transport, stdout carries the MCP JSON-RPC stream,
 * and a single stray log line on stdout would corrupt the protocol.
 *
 * Secrets are redacted defensively in case a caller ever logs a header or token object.
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino(
    {
      level,
      base: { service: 'loan-portfolio-mcp' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'token',
          '*.token',
          'authorization',
          '*.authorization',
          'headers.authorization',
          'req.headers.authorization',
          'secret',
          '*.secret',
        ],
        censor: '[REDACTED]',
      },
    },
    pino.destination({ fd: 2, sync: false }),
  );
}

export type { Logger };
