import { ROLES } from '../auth/principal.js';
import { DelinquencyTrendInput, DelinquencyTrendOutput } from '../schemas/tools.js';
import { defineTool } from './types.js';

export const getDelinquencyTrendTool = defineTool({
  name: 'get_delinquency_trend',
  title: 'Delinquency trend',
  description: [
    'Monthly delinquency rate (loans 30+ days past due ÷ active loans) at each month-end for the last N months',
    '(default 12, max 36), ending at the data as-of date, recomputed from payment history. Optionally filter by',
    'region and/or loan type. Points are ordered oldest to newest. The final point equals the delinquencyRate',
    'reported by get_portfolio_summary for the same filters.',
  ].join(' '),
  inputSchema: DelinquencyTrendInput,
  outputSchema: DelinquencyTrendOutput,
  allowedRoles: ROLES,
  handler: (input, ctx, { repo }) => repo.getDelinquencyTrend(ctx.principal, input),
  rowCount: (out) => out.points.length,
});
