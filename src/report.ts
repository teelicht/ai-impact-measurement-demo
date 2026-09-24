import { readFileSync } from 'node:fs';
import { aggregate, type OperationalReport } from './aggregate.js';
import { evaluateFinancialCase, type FinancialCase, type FinancialResult } from './finance.js';
import type { SourceBundle } from './model.js';

export interface ReportView {
  operational: OperationalReport;
  context?: SourceBundle['context'];
  actions: { owner: string; action: string; condition: string }[];
  examples: { id: string; kind: string; treatment: string }[];
  migration: { scope: string; assumptions: string[]; result: FinancialResult };
}

export function buildReport(bundle: SourceBundle): ReportView {
  const operational = aggregate(bundle);
  const migrationCase = JSON.parse(readFileSync(
    new URL('../../data/migration.json', import.meta.url), 'utf8',
  )) as FinancialCase & { scope: string; assumptions: string[] };
  const examples = (bundle.tickets ?? []).filter(ticket =>
    ticket.id === 'API-101' || ticket.id === 'API-102' || ticket.parentId || ticket.status === 'open')
    .slice(0, 8).map(ticket => ({ id: ticket.id, kind: ticket.type,
      treatment: ticket.parentId ? 'Child: excluded from approved Stories and Tasks count'
        : ticket.status === 'open' ? 'Open: not approved'
          : ticket.approvals.length > 1 ? 'First approval only; later release link excluded'
            : 'Eligible Story or Task: counted at first release approval',
    }));
  return {
    operational,
    context: bundle.context,
    actions: [
      { owner: 'Service owner', action: 'Record approved controls, available capacity, spending limits and accountable owners.',
        condition: 'Check guardrails before changing the scope of AI-assisted work.' },
      { owner: 'Delivery lead', action: 'Capture start and first release approval for every eligible Story or Task, including open work.',
        condition: 'Evaluate lead time only after coverage is checked.' },
      { owner: 'Finance and engineering', action: 'Record non-overlapping review, correction, enablement and platform costs; reconcile shared charges once.',
        condition: 'Do not calculate API-team ROI from tool spend alone.' },
      { owner: 'Quality owner', action: 'Link incoming bugs to releases and define follow-up windows.',
        condition: 'Only then assess escaped defects.' },
    ],
    examples,
    migration: { scope: migrationCase.scope, assumptions: migrationCase.assumptions,
      result: evaluateFinancialCase(migrationCase) },
  };
}