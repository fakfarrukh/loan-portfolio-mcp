import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/auth/principal.js';
import { DATA_DICTIONARY_URI } from '../../src/resources/data-dictionary.js';
import { createMcpServer } from '../../src/server.js';
import { analyst } from '../helpers.js';
import { createHarness } from './harness.js';

/** End-to-end over the real MCP protocol (in-memory transport, real SDK client). */
describe('MCP protocol integration', () => {
  const h = createHarness();
  let principal: Principal | undefined = analyst;
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  beforeAll(async () => {
    const server = createMcpServer({
      executor: h.executor,
      repo: h.repo,
      resolvePrincipal: () => principal,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });
  afterAll(async () => {
    await client.close();
    h.close();
  });

  it('lists five read-only tools with JSON Schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'get_portfolio_summary',
      'search_loans',
      'get_loan_details',
      'get_delinquency_trend',
      'explain_metric',
    ]);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    const search = tools.find((t) => t.name === 'search_loans')!;
    expect(search.inputSchema.additionalProperties).toBe(false);
    expect(
      (search.inputSchema.properties as Record<string, { maximum?: number }>).pageSize!.maximum,
    ).toBe(50);
  });

  it('returns structured content for a successful call', async () => {
    const r = await client.callTool({
      name: 'get_portfolio_summary',
      arguments: { region: 'West' },
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { filters: { region: string } }).filters.region).toBe('West');
  });

  it('returns a structured, recoverable error for bad input', async () => {
    const r = await client.callTool({ name: 'search_loans', arguments: { pageSize: 500 } });
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content as { text: string }[])[0]!.text) as {
      error: { code: string; details: unknown };
    };
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('serves the data dictionary resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(DATA_DICTIONARY_URI);
    const r = await client.readResource({ uri: DATA_DICTIONARY_URI });
    const text = (r.contents[0] as { text: string }).text;
    expect(text).toContain('# Loan Portfolio');
    expect(text).toContain('synthetic');
    expect(text).toContain('delinquency_rate');
  });

  it('serves the monthly review prompt and validates its arguments', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts[0]!.name).toBe('monthly_portfolio_review');
    const p = await client.getPrompt({
      name: 'monthly_portfolio_review',
      arguments: { region: 'Southeast', trend_months: '9' },
    });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('Southeast');
    expect(text).toContain('months: 9');
    await expect(
      client.getPrompt({ name: 'monthly_portfolio_review', arguments: { region: 'Mars' } }),
    ).rejects.toThrow(/Invalid prompt arguments/);
    await expect(
      client.getPrompt({ name: 'monthly_portfolio_review', arguments: { trend_months: '99' } }),
    ).rejects.toThrow(/Invalid prompt arguments/);
  });

  it('refuses resource access without an identity', async () => {
    principal = undefined;
    try {
      await expect(client.readResource({ uri: DATA_DICTIONARY_URI })).rejects.toThrow(
        /Authentication required/,
      );
      const r = await client.callTool({ name: 'explain_metric', arguments: {} });
      expect(r.isError).toBe(true);
    } finally {
      principal = analyst;
    }
  });

  describe('audit of resource and prompt reads', () => {
    const lastAudit = () => h.audit.recent(1)[0]!;

    it('records a successful resource read', async () => {
      await client.readResource({ uri: DATA_DICTIONARY_URI });
      expect(lastAudit()).toMatchObject({
        kind: 'resource',
        name: DATA_DICTIONARY_URI,
        subject: analyst.subject,
        role: 'analyst',
        outcome: 'success',
        error_code: null,
        row_count: 1,
      });
      expect(JSON.parse(lastAudit().arguments_json as string)).toEqual({
        uri: DATA_DICTIONARY_URI,
      });
    });

    it('records a read of an unknown resource as not_found', async () => {
      await expect(client.readResource({ uri: 'portfolio://secrets' })).rejects.toThrow(
        /Unknown resource/,
      );
      expect(lastAudit()).toMatchObject({
        kind: 'resource',
        name: 'portfolio://secrets',
        outcome: 'not_found',
        error_code: 'NOT_FOUND',
      });
    });

    it('records an unauthenticated resource read as denied', async () => {
      principal = undefined;
      try {
        await expect(client.readResource({ uri: DATA_DICTIONARY_URI })).rejects.toThrow();
      } finally {
        principal = analyst;
      }
      expect(lastAudit()).toMatchObject({
        kind: 'resource',
        subject: 'anonymous',
        outcome: 'denied',
        error_code: 'UNAUTHENTICATED',
      });
    });

    it('records a successful prompt read with validated arguments', async () => {
      await client.getPrompt({
        name: 'monthly_portfolio_review',
        arguments: { region: 'Southeast', trend_months: '9' },
      });
      expect(lastAudit()).toMatchObject({
        kind: 'prompt',
        name: 'monthly_portfolio_review',
        subject: analyst.subject,
        outcome: 'success',
      });
      // Validated form: trend_months parsed from the string "9" to the number 9.
      expect(JSON.parse(lastAudit().arguments_json as string)).toEqual({
        region: 'Southeast',
        trend_months: 9,
      });
    });

    it('records a prompt read with invalid arguments as invalid_input', async () => {
      await expect(
        client.getPrompt({ name: 'monthly_portfolio_review', arguments: { region: 'Mars' } }),
      ).rejects.toThrow(/Invalid prompt arguments/);
      expect(lastAudit()).toMatchObject({
        kind: 'prompt',
        outcome: 'invalid_input',
        error_code: 'INVALID_INPUT',
      });
      expect(JSON.parse(lastAudit().arguments_json as string)).toEqual({ region: 'Mars' });
    });

    it('records a read of an unknown prompt as not_found', async () => {
      await expect(client.getPrompt({ name: 'drop_everything' })).rejects.toThrow(/Unknown prompt/);
      expect(lastAudit()).toMatchObject({ kind: 'prompt', outcome: 'not_found' });
    });
  });
});
