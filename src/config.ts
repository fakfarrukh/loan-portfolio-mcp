import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Project root, derived from this file's location (src/ or dist/ are both one level down).
 * Default data paths are anchored here rather than to the working directory, because MCP clients
 * such as Claude Desktop launch the server from an unpredictable cwd.
 */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, 'data', 'portfolio.db');
export const DEFAULT_AUDIT_DB_PATH = resolve(PROJECT_ROOT, 'data', 'audit.db');

/**
 * All runtime configuration comes from environment variables and is validated once at startup.
 * An invalid configuration fails fast with a readable message instead of surfacing later as a
 * confusing runtime error.
 */

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0),
);

const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // ---- Storage ----------------------------------------------------------------------------
    DB_PATH: z.string().min(1).default(DEFAULT_DB_PATH),
    AUDIT_DB_PATH: z.string().min(1).default(DEFAULT_AUDIT_DB_PATH),

    // ---- Transport --------------------------------------------------------------------------
    MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
    HTTP_HOST: z.string().default('127.0.0.1'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Public URL of the /mcp endpoint; used for OAuth protected-resource metadata. */
    PUBLIC_URL: z.url().optional(),
    HTTP_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),

    // ---- Local (stdio) identity: the process owner is trusted; role is set by whoever launches it.
    STDIO_SUBJECT: z.string().min(1).max(128).default('local-user'),
    STDIO_ROLE: z.enum(['analyst', 'admin']).default('analyst'),

    // ---- HTTP auth (JWT bearer) ---------------------------------------------------------------
    AUTH_JWKS_URL: z.url().optional(),
    AUTH_JWT_SECRET: z.string().optional(),
    AUTH_ISSUER: z.string().min(1).optional(),
    AUTH_AUDIENCE: z.string().min(1).optional(),
    /** Claim holding role or group membership. Okta: `groups`; Entra ID: `roles`. */
    AUTH_ROLE_CLAIM: z.string().min(1).default('roles'),
    /** Claim values (e.g. Okta group names) that map to each application role. */
    AUTH_ADMIN_VALUES: csv.default(['admin']),
    AUTH_ANALYST_VALUES: csv.default(['analyst']),
    AUTH_CLOCK_TOLERANCE_SEC: z.coerce.number().int().min(0).max(300).default(30),
    /** Authorization server metadata URL advertised to clients (RFC 9728). Optional. */
    AUTH_AUTHORIZATION_SERVER: z.url().optional(),

    // ---- Guardrails --------------------------------------------------------------------------
    TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    MAX_TOOL_INPUT_BYTES: z.coerce.number().int().min(256).max(65_536).default(4_096),

    // ---- Observability -----------------------------------------------------------------------
    OTEL_TRACES_EXPORTER: z.enum(['console', 'none']).default('console'),
    OTEL_SERVICE_NAME: z.string().default('loan-portfolio-mcp'),
    AUDIT_ENABLED: boolish.default(true),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.MCP_TRANSPORT !== 'http') return;

    const hasJwks = cfg.AUTH_JWKS_URL !== undefined;
    const hasSecret = cfg.AUTH_JWT_SECRET !== undefined && cfg.AUTH_JWT_SECRET.length > 0;
    if (hasJwks === hasSecret) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_JWKS_URL'],
        message: 'HTTP transport requires exactly one of AUTH_JWKS_URL or AUTH_JWT_SECRET',
      });
    }
    if (hasSecret && (cfg.AUTH_JWT_SECRET?.length ?? 0) < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_JWT_SECRET'],
        message: 'AUTH_JWT_SECRET must be at least 32 characters',
      });
    }
    if (!cfg.AUTH_ISSUER || !cfg.AUTH_AUDIENCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_ISSUER'],
        message: 'HTTP transport requires AUTH_ISSUER and AUTH_AUDIENCE',
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings as "unset" so a blank line in .env does not override a default.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  return parsed.data;
}

/**
 * Loads `<project>/.env` if present. Variables already set in the real environment win, so a
 * value passed by Claude Desktop's config or by Docker always overrides the file.
 */
export function loadDotEnv(path: string = resolve(PROJECT_ROOT, '.env')): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
