import { ROLES } from '../auth/principal.js';
import { PortfolioSummaryInput, PortfolioSummaryOutput } from '../schemas/tools.js';
import { defineTool } from './types.js';

export const getPortfolioSummaryTool = defineTool({
  name: 'get_portfolio_summary',
  title: 'Portfolio summary',
  description: [
    'Headline metrics for the loan portfolio at the data as-of date: active loan count, total outstanding balance,',
    'weighted and simple average interest rate, delinquency rate (count and balance basis) and default rate.',
    'Optionally filter by region and/or loan type, and optionally break results down with groupBy',
    '(region, loan_type or risk_grade) — use groupBy to compare segments in a single call.',
    'Rates are percentages (6.25 = 6.25%); money is USD. Call explain_metric for exact definitions before',
    'describing a metric to the user.',
  ].join(' '),
  inputSchema: PortfolioSummaryInput,
  outputSchema: PortfolioSummaryOutput,
  allowedRoles: ROLES,
  handler: (input, ctx, { repo }) => repo.getPortfolioSummary(ctx.principal, input),
  rowCount: (out) => 1 + (out.groups?.length ?? 0),
});
