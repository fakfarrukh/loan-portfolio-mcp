import type { z } from 'zod';
import type { Principal, Role } from '../auth/principal.js';
import type { PortfolioRepository } from '../db/repository.js';

export interface ToolContext {
  principal: Principal;
  correlationId: string;
  /** Aborted on timeout or client cancellation. Long-running handlers should honour it. */
  signal: AbortSignal;
}

export interface ToolDeps {
  repo: PortfolioRepository;
}

/**
 * A tool is pure business logic plus contracts. Cross-cutting concerns (validation, auth,
 * tracing, timeouts, auditing, error mapping) are applied uniformly by the ToolExecutor.
 */
export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  /** Written for the LLM: when to use the tool, what it returns, and how to page/filter. */
  description: string;
  inputSchema: I;
  outputSchema: O;
  /** Roles allowed to call this tool. Masking is separate and enforced in the data layer. */
  allowedRoles: readonly Role[];
  handler: (input: z.output<I>, ctx: ToolContext, deps: ToolDeps) => Promise<z.input<O>>;
  /** Number of data rows returned, for the audit log. */
  rowCount: (output: z.output<O>) => number;
}

/** Helper that preserves generic inference when declaring a tool. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}
