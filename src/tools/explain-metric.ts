import { ROLES } from '../auth/principal.js';
import { METRICS } from '../schemas/metrics.js';
import { ExplainMetricInput, ExplainMetricOutput } from '../schemas/tools.js';
import { defineTool } from './types.js';

export const explainMetricTool = defineTool({
  name: 'explain_metric',
  title: 'Explain a metric',
  description: [
    'Returns the authoritative definition, formula, unit and population for a portfolio metric, exactly as the',
    'server computes it. Call this before explaining or comparing metrics so you do not guess at definitions',
    '(e.g. whether delinquency includes defaults, or whether an average is balance-weighted).',
    'Omit `metric` to list every available metric.',
  ].join(' '),
  inputSchema: ExplainMetricInput,
  outputSchema: ExplainMetricOutput,
  allowedRoles: ROLES,
  handler: (input) =>
    Promise.resolve({
      metrics:
        input.metric === undefined ? [...METRICS] : METRICS.filter((m) => m.id === input.metric),
    }),
  rowCount: (out) => out.metrics.length,
});
