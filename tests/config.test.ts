import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDotEnv } from '../src/config.js';
import { AppError, ErrorCode, toSafeError } from '../src/errors.js';

describe('config', () => {
  it('anchors default data paths to the project, not the working directory', () => {
    const cfg = loadConfig({});
    expect(isAbsolute(cfg.DB_PATH)).toBe(true);
    expect(cfg.DB_PATH.replaceAll('\\', '/')).toMatch(/\/data\/portfolio\.db$/);
    expect(cfg.AUDIT_DB_PATH.replaceAll('\\', '/')).toMatch(/\/data\/audit\.db$/);
  });

  it('applies safe defaults', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      MCP_TRANSPORT: 'stdio',
      STDIO_ROLE: 'analyst',
      HTTP_HOST: '127.0.0.1',
      TOOL_TIMEOUT_MS: 5000,
      MAX_TOOL_INPUT_BYTES: 4096,
      AUDIT_ENABLED: true,
    });
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ STDIO_ROLE: '' }).STDIO_ROLE).toBe('analyst');
  });

  it('parses comma-separated role mappings', () => {
    const cfg = loadConfig({ AUTH_ADMIN_VALUES: 'Portfolio-Admins, Risk-Admins' });
    expect(cfg.AUTH_ADMIN_VALUES).toEqual(['Portfolio-Admins', 'Risk-Admins']);
  });

  it('reports every invalid value in one readable error', () => {
    try {
      loadConfig({ STDIO_ROLE: 'root', HTTP_PORT: '99999' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/STDIO_ROLE/);
      expect((e as Error).message).toMatch(/HTTP_PORT/);
    }
  });
});

describe('loadDotEnv', () => {
  it('fills unset variables but never overrides the real environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'LOAN_MCP_T1=from-file\nLOAN_MCP_T2=from-file\n');
    process.env.LOAN_MCP_T1 = 'from-env';
    try {
      loadDotEnv(file);
      expect(process.env.LOAN_MCP_T1).toBe('from-env');
      expect(process.env.LOAN_MCP_T2).toBe('from-file');
      expect(() => {
        loadDotEnv(join(dir, 'missing.env'));
      }).not.toThrow();
    } finally {
      delete process.env.LOAN_MCP_T1;
      delete process.env.LOAN_MCP_T2;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toSafeError', () => {
  it('keeps AppError messages and hides everything else', () => {
    expect(toSafeError(new AppError(ErrorCode.NotFound, 'Loan LN-1 was not found'), 'c')).toEqual({
      code: 'NOT_FOUND',
      message: 'Loan LN-1 was not found',
      correlationId: 'c',
    });
    const hidden = toSafeError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(hidden.code).toBe('INTERNAL_ERROR');
    expect(hidden.message).not.toContain('undefined');
    expect(toSafeError('a string').code).toBe('INTERNAL_ERROR');
  });
});
