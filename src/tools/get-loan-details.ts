import { ROLES } from '../auth/principal.js';
import { AppError, ErrorCode } from '../errors.js';
import { LoanDetailsInput, LoanDetailsOutput } from '../schemas/tools.js';
import { defineTool } from './types.js';

export const getLoanDetailsTool = defineTool({
  name: 'get_loan_details',
  title: 'Loan details',
  description: [
    'Full detail for one loan identified by its reference (format LN-000123, as returned by search_loans):',
    'loan terms, current status and days past due, customer (name/e-mail masked unless the caller is an admin),',
    'risk-rating history, and the most recent payments (newest first, default 24, max 120) with a payment summary.',
    'Returns a NOT_FOUND error if the reference does not exist.',
  ].join(' '),
  inputSchema: LoanDetailsInput,
  outputSchema: LoanDetailsOutput,
  allowedRoles: ROLES,
  handler: async (input, ctx, { repo }) => {
    const details = await repo.getLoanDetails(ctx.principal, input.loanRef, {
      paymentLimit: input.paymentLimit,
    });
    if (!details) throw new AppError(ErrorCode.NotFound, `Loan ${input.loanRef} was not found`);
    return details;
  },
  rowCount: (out) => 1 + out.payments.length + out.riskRatings.length,
});
