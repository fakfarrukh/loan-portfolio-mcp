import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContainer } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { SearchLoansResult } from '../../src/schemas/tools.js';
import { createHttpApp } from '../../src/transport/http.js';
import { createHarness, makeTracer, silentLogger, type Harness } from '../tools/harness.js';
import { AUDIENCE, hsToken, ISSUER, TEST_SECRET } from './tokens.js';

describe('HTTP transport with bearer auth', () => {
  let h: Harness;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    h = createHarness();
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      AUTH_JWT_SECRET: TEST_SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_AUDIENCE: AUDIENCE,
      AUTH_ROLE_CLAIM: 'groups',
      AUTH_ADMIN_VALUES: 'Portfolio-Admins',
      AUTH_ANALYST_VALUES: 'Portfolio-Analysts',
      PUBLIC_URL: 'https://mcp.example.com/mcp',
      HTTP_MAX_BODY_BYTES: '2048',
    });
    const app: AppContainer = {
      config,
      logger: silentLogger,
      tracer: makeTracer().tracer,
      repo: h.repo,
      audit: h.audit,
      executor: h.executor,
      close: () => Promise.resolve(),
    };
    server = createHttpApp(app).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    h.close();
  });

  const connect = async (token: string) => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  it('serves an unauthenticated health check', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('publishes OAuth protected-resource metadata', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(await res.json()).toMatchObject({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: [ISSUER],
    });
  });

  it('returns 401 with a WWW-Authenticate challenge when no token is sent', async () => {
    const res = await rpc(listTools);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer .*resource_metadata=/);
  });

  it('returns 401 for an invalid token and 403 for a token without a role', async () => {
    expect((await rpc(listTools, { authorization: 'Bearer nope' })).status).toBe(401);
    const noRole = await hsToken({ groups: ['Everyone'] });
    expect((await rpc(listTools, { authorization: `Bearer ${noRole}` })).status).toBe(403);
  });

  it('lets an analyst call tools, with names masked', async () => {
    const client = await connect(await hsToken({ groups: ['Portfolio-Analysts'] }, { sub: 'ana' }));
    try {
      const r = await client.callTool({ name: 'search_loans', arguments: { pageSize: 3 } });
      const data = r.structuredContent as SearchLoansResult;
      expect(data.piiMasked).toBe(true);
      expect(data.items[0]!.customerName).toContain('***');
      expect(h.audit.recent(1)[0]).toMatchObject({
        subject: 'ana',
        role: 'analyst',
        auth_method: 'jwt',
      });
    } finally {
      await client.close();
    }
  });

  it('lets an admin see customer names', async () => {
    const client = await connect(await hsToken({ groups: ['Portfolio-Admins'] }, { sub: 'adm' }));
    try {
      const r = await client.callTool({ name: 'search_loans', arguments: { pageSize: 3 } });
      expect((r.structuredContent as SearchLoansResult).piiMasked).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('rejects oversized bodies with 413 and no internals', async () => {
    const token = await hsToken();
    const res = await rpc(
      { ...listTools, params: { padding: 'x'.repeat(4096) } },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).not.toMatch(/at .*\.js|node_modules|PayloadTooLarge/);
  });

  it('rejects malformed JSON without leaking parser details', async () => {
    const res = await rpc('{"jsonrpc": "2.0", bad json', {
      authorization: `Bearer ${await hsToken()}`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/Unexpected token|SyntaxError|at /);
  });

  it('rejects GET/DELETE on the stateless endpoint', async () => {
    expect((await fetch(`${baseUrl}/mcp`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });

  it('sets defensive headers', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('config validation for HTTP mode', () => {
  it('requires exactly one key source and issuer/audience', () => {
    expect(() => loadConfig({ MCP_TRANSPORT: 'http' })).toThrow(/AUTH_JWKS_URL or AUTH_JWT_SECRET/);
    expect(() =>
      loadConfig({
        MCP_TRANSPORT: 'http',
        AUTH_JWT_SECRET: 'short',
        AUTH_ISSUER: 'i',
        AUTH_AUDIENCE: 'a',
      }),
    ).toThrow(/at least 32/);
    expect(() =>
      loadConfig({
        MCP_TRANSPORT: 'http',
        AUTH_JWT_SECRET: TEST_SECRET,
        AUTH_JWKS_URL: 'https://idp.example.com/keys',
        AUTH_ISSUER: 'i',
        AUTH_AUDIENCE: 'a',
      }),
    ).toThrow(/exactly one/);
  });

  it('defaults stdio mode to the least-privileged role', () => {
    expect(loadConfig({}).STDIO_ROLE).toBe('analyst');
  });
});
