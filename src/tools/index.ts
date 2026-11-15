import { explainMetricTool } from './explain-metric.js';
import { getDelinquencyTrendTool } from './get-delinquency-trend.js';
import { getLoanDetailsTool } from './get-loan-details.js';
import { getPortfolioSummaryTool } from './get-portfolio-summary.js';
import { searchLoansTool } from './search-loans.js';
import type { ToolDefinition } from './types.js';

/** Registry of all tools exposed by the server. Order is the order clients list them in. */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  getPortfolioSummaryTool,
  searchLoansTool,
  getLoanDetailsTool,
  getDelinquencyTrendTool,
  explainMetricTool,
];
