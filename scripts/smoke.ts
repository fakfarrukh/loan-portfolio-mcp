/**
 * End-to-end smoke test of the *built* server over stdio, exactly as Claude Desktop runs it.
 * Logging and console tracing are left ON to prove nothing leaks onto stdout (which would corrupt
 * the JSON-RPC stream).
 *
 *   npm run build && npm run seed && npm run smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const role = process.env.STDIO_ROLE ?? 'analyst';
const expectMasked = role !== 'admin';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...(process.env as Record<string, string>),
    LOG_LEVEL: 'info',
    OTEL_TRACES_EXPORTER: 'console',
    STDIO_ROLE: role,
  },
  stderr: 'pipe',
});
let stderrBytes = 0;
transport.stderr?.on('data', (chunk: Buffer) => {
  stderrBytes += chunk.length;
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};

const { tools } = await client.listTools();
check('tools/list returns 5 tools', tools.length === 5, tools.map((t) => t.name).join(', '));

const summary = await client.callTool({
  name: 'get_portfolio_summary',
  arguments: { groupBy: 'region' },
});
const s = summary.structuredContent as {
  asOfDate: string;
  totals: { activeLoanCount: number; delinquencyRate: number };
};
check(
  'get_portfolio_summary',
  !summary.isError,
  `as of ${s.asOfDate}, ${s.totals.activeLoanCount} active, ${s.totals.delinquencyRate}% delinquent`,
);

const search = await client.callTool({
  name: 'search_loans',
  arguments: { status: ['default'], pageSize: 3 },
});
const items = (search.structuredContent as { items: { loanRef: string; customerName: string }[] })
  .items;
check(
  `search_loans (names ${expectMasked ? 'masked' : 'visible'} for ${role})`,
  !search.isError && items.every((i) => i.customerName.includes('***') === expectMasked),
  items.map((i) => `${i.loanRef}:${i.customerName}`).join(' '),
);

const details = await client.callTool({
  name: 'get_loan_details',
  arguments: { loanRef: items[0]?.loanRef ?? 'LN-000001' },
});
check('get_loan_details', !details.isError);

const trend = await client.callTool({ name: 'get_delinquency_trend', arguments: { months: 6 } });
const pts = (trend.structuredContent as { points: { month: string; delinquencyRate: number }[] })
  .points;
check(
  'get_delinquency_trend',
  pts.length === 6,
  pts.map((p) => `${p.month}=${p.delinquencyRate}%`).join(' '),
);

const metric = await client.callTool({
  name: 'explain_metric',
  arguments: { metric: 'weighted_average_rate' },
});
check('explain_metric', !metric.isError);

const bad = await client.callTool({ name: 'search_loans', arguments: { pageSize: 500 } });
check('invalid input returns structured error', bad.isError === true);

const res = await client.readResource({ uri: 'portfolio://schema/data-dictionary' });
check('data dictionary resource', JSON.stringify(res).includes('Data Dictionary'));

const prompt = await client.getPrompt({
  name: 'monthly_portfolio_review',
  arguments: { region: 'Southeast' },
});
check('monthly review prompt', prompt.messages.length === 1);

check('server logged to stderr (not stdout)', stderrBytes > 0, `${stderrBytes} bytes on stderr`);
await client.close();
