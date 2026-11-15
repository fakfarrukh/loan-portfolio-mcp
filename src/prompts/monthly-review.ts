import { z } from 'zod';
import { RegionSchema } from '../schemas/domain.js';

export const MONTHLY_REVIEW_PROMPT = {
  name: 'monthly_portfolio_review',
  title: 'Monthly portfolio review',
  description:
    'Produces a structured monthly credit review of the loan portfolio (or one region) using the server tools.',
  arguments: [
    {
      name: 'region',
      description: 'Optional region to focus on (Northeast, Southeast, Midwest, Southwest, West).',
      required: false,
    },
    {
      name: 'trend_months',
      description: 'How many months of delinquency trend to analyse (1-36, default 6).',
      required: false,
    },
  ],
} as const;

/** Prompt arguments arrive as strings; validate them like any other input. */
export const MonthlyReviewArgs = z.strictObject({
  region: RegionSchema.optional(),
  trend_months: z
    .string()
    .regex(/^\d{1,2}$/, 'trend_months must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(36))
    .optional(),
});

export function renderMonthlyReview(args: z.output<typeof MonthlyReviewArgs>): string {
  const scope = args.region ? `the ${args.region} region` : 'the whole portfolio';
  const regionArg = args.region ? `, region: "${args.region}"` : '';
  const months = args.trend_months ?? 6;

  return `Prepare the monthly credit review for ${scope}.

Work through these steps using the loan-portfolio tools. Do not invent numbers: every figure must come from a tool result.

1. Call \`explain_metric\` (no arguments) so you use the server's exact metric definitions.
2. Call \`get_portfolio_summary\` with { groupBy: "${args.region ? 'loan_type' : 'region'}"${regionArg} } for headline metrics and the segment breakdown.
3. Call \`get_delinquency_trend\` with { months: ${months}${regionArg} }.
4. Call \`search_loans\` with { status: ["default"], sortBy: "current_balance", sortDirection: "desc", pageSize: 10${regionArg} } to identify the largest defaulted exposures.
5. Call \`get_loan_details\` on the single largest defaulted loan to understand how it deteriorated.

Then write the review with these sections:
- **Headline** — two sentences: portfolio size, delinquency rate, direction of travel.
- **Key metrics** — a table: active loans, outstanding balance, weighted average rate, delinquency rate (count and balance basis), default rate.
- **Trend** — month-by-month delinquency, and whether the latest month is above or below the period average.
- **Segments** — best and worst ${args.region ? 'loan types' : 'regions'} by delinquency rate, with numbers.
- **Watch list** — the largest defaulted loans (loan reference, type, balance, days past due). Use loan references, not customer names.
- **Recommendations** — two or three concrete, data-backed actions.
- **Data notes** — the as-of date, and that the data is synthetic.`;
}
