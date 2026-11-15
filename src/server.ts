// The low-level Server is deprecated for general use in favour of McpServer, but remains the
// supported API for advanced cases. We need it so our pipeline (not the SDK) validates input and
// every rejected call is audited. See DECISIONS.md.
/* eslint-disable @typescript-eslint/no-deprecated */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  ErrorCode as McpErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Principal } from './auth/principal.js';
import type { PortfolioRepository } from './db/repository.js';
import { AppError, ErrorCode, type SafeError } from './errors.js';
import {
  MONTHLY_REVIEW_PROMPT,
  MonthlyReviewArgs,
  renderMonthlyReview,
} from './prompts/monthly-review.js';
import { DATA_DICTIONARY_URI, renderDataDictionary } from './resources/data-dictionary.js';
import type { ToolExecutor } from './tools/executor.js';

export const SERVER_INFO = { name: 'loan-portfolio-mcp', version: '1.0.0' } as const;

export type RequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Maps the transport-level request context to an application identity (or undefined). */
export type PrincipalResolver = (extra: RequestExtra) => Principal | undefined;

export interface CreateServerOptions {
  executor: ToolExecutor;
  repo: PortfolioRepository;
  resolvePrincipal: PrincipalResolver;
}

type JsonSchemaObject = Tool['inputSchema'];

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaObject {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: 'object' };
}

/**
 * Builds the MCP protocol adapter. All business rules live in the ToolExecutor and repository;
 * this layer only translates between MCP messages and those components.
 *
 * The low-level `Server` is used (rather than `McpServer`) so that *our* pipeline performs input
 * validation — that way rejected calls are audited and return the same structured error shape.
 */
export function createMcpServer(opts: CreateServerOptions): Server {
  const { executor, repo, resolvePrincipal } = opts;

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: [
      'Read-only access to a SYNTHETIC loan portfolio.',
      'Use explain_metric for definitions, get_portfolio_summary for totals and segment comparisons,',
      'get_delinquency_trend for time series, search_loans to find loans (max 50 per page),',
      'and get_loan_details for one loan. Customer names may be masked; refer to loans by loanRef.',
    ].join(' '),
  });

  // Pre-compute tool listings once; they never change at runtime.
  const toolList: Tool[] = executor.list().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: toJsonSchema(t.inputSchema, 'input'),
    outputSchema: toJsonSchema(t.outputSchema, 'output'),
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const principal = resolvePrincipal(extra);
      const result = await executor.execute(
        request.params.name,
        request.params.arguments,
        principal,
        extra.signal,
      );
      if (result.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result.data) }],
          structuredContent: result.data as Record<string, unknown>,
        };
      }
      // Tool-level errors are returned as results (isError) so the model can read and recover.
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
      };
    },
  );

  const requirePrincipal = (extra: RequestExtra): Principal => {
    const p = resolvePrincipal(extra);
    if (!p) throw new McpError(McpErrorCode.InvalidRequest, 'Authentication required');
    return p;
  };

  server.setRequestHandler(ListResourcesRequestSchema, (_req, extra) => {
    requirePrincipal(extra);
    return {
      resources: [
        {
          uri: DATA_DICTIONARY_URI,
          name: 'data-dictionary',
          title: 'Schema & data dictionary',
          description:
            'Tables, columns, enums, PII flags and metric formulas for the loan portfolio.',
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  // Resource reads are audited like tool calls (kind = 'resource').
  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    const uri = req.params.uri;
    const result = await executor.runAudited(
      'resource',
      uri,
      { uri },
      resolvePrincipal(extra),
      async () => {
        if (uri !== DATA_DICTIONARY_URI) {
          throw new AppError(ErrorCode.NotFound, 'Unknown resource');
        }
        return renderDataDictionary(await repo.getDataAsOfDate());
      },
    );
    if (!result.ok) throw toMcpError(result.error);
    return { contents: [{ uri, mimeType: 'text/markdown', text: result.value }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, (_req, extra) => {
    requirePrincipal(extra);
    return {
      prompts: [{ ...MONTHLY_REVIEW_PROMPT, arguments: [...MONTHLY_REVIEW_PROMPT.arguments] }],
    };
  });

  // Prompt reads are audited like tool calls (kind = 'prompt'), with validated arguments.
  server.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
    const { name } = req.params;
    const result = await executor.runAudited(
      'prompt',
      name,
      req.params.arguments ?? {},
      resolvePrincipal(extra),
      (_principal, audit) => {
        if (name !== MONTHLY_REVIEW_PROMPT.name) {
          throw new AppError(ErrorCode.NotFound, 'Unknown prompt');
        }
        const parsed = MonthlyReviewArgs.safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          throw new AppError(ErrorCode.InvalidInput, `Invalid prompt arguments: ${detail}`);
        }
        audit.args = parsed.data;
        return Promise.resolve(renderMonthlyReview(parsed.data));
      },
    );
    if (!result.ok) throw toMcpError(result.error);
    return {
      description: MONTHLY_REVIEW_PROMPT.description,
      messages: [{ role: 'user', content: { type: 'text', text: result.value } }],
    };
  });

  return server;
}

/**
 * Resource and prompt failures are protocol errors (unlike tool errors, which are results the
 * model can read). The message is the same safe text; the correlationId travels in `data`.
 */
function toMcpError(error: SafeError): McpError {
  const code =
    error.code === ErrorCode.Unauthenticated || error.code === ErrorCode.Forbidden
      ? McpErrorCode.InvalidRequest
      : error.code === ErrorCode.InvalidInput || error.code === ErrorCode.NotFound
        ? McpErrorCode.InvalidParams
        : McpErrorCode.InternalError;
  return new McpError(code, error.message, {
    code: error.code,
    correlationId: error.correlationId,
  });
}
