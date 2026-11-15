import { randomUUID } from 'node:crypto';

/**
 * Error codes are a closed, documented set. Clients (and LLMs) can branch on `code`;
 * nothing else about the internal failure is disclosed.
 */
export const ErrorCode = {
  InvalidInput: 'INVALID_INPUT',
  InputTooLarge: 'INPUT_TOO_LARGE',
  NotFound: 'NOT_FOUND',
  Forbidden: 'FORBIDDEN',
  Unauthenticated: 'UNAUTHENTICATED',
  Timeout: 'TIMEOUT',
  UnknownTool: 'UNKNOWN_TOOL',
  Internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An error whose message is safe to show to the client. */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Optional safe, structured details (e.g. which field failed validation). */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface SafeError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  /** Correlates the client-visible error with server logs and the audit record. */
  correlationId: string;
}

/**
 * Converts any thrown value into a client-safe error.
 * Known `AppError`s keep their message; anything else becomes a generic INTERNAL_ERROR so that
 * stack traces, SQL text, file paths and driver messages never leave the process.
 */
export function toSafeError(err: unknown, correlationId: string = randomUUID()): SafeError {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
      correlationId,
    };
  }
  return {
    code: ErrorCode.Internal,
    message: 'An internal error occurred. Quote the correlationId when reporting this issue.',
    correlationId,
  };
}
