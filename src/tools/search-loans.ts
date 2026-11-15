import { ROLES } from '../auth/principal.js';
import { MAX_PAGE_SIZE } from '../schemas/domain.js';
import { SearchLoansInput, SearchLoansOutput } from '../schemas/tools.js';
import { defineTool } from './types.js';

export const searchLoansTool = defineTool({
  name: 'search_loans',
  title: 'Search loans',
  description: [
    'Find individual loans matching filters: status (current, delinquent, default, paid_off), region, loan type,',
    'latest risk grade, current balance range (USD), origination date range (YYYY-MM-DD) and minimum days past due.',
    `Results are paginated: at most ${MAX_PAGE_SIZE} rows per call. The response includes totalCount, totalPages`,
    'and hasMore; request the next page only if the user needs more rows. For counts and totals, prefer',
    'get_portfolio_summary instead of paging through results. Customer names may be masked depending on the',
    "caller's role; do not attempt to unmask them.",
  ].join(' '),
  inputSchema: SearchLoansInput,
  outputSchema: SearchLoansOutput,
  allowedRoles: ROLES,
  handler: (input, ctx, { repo }) => repo.searchLoans(ctx.principal, input),
  rowCount: (out) => out.items.length,
});
