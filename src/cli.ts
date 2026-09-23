import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfigured } from './adapters/load.js';
import { loadSynthetic } from './adapters/synthetic.js';
import { buildReport } from './report.js';
import { renderHtml } from './html.js';

function options(args: string[]): { config?: string; out: string } {
  let config: string | undefined;
  let out = 'output';
  let outSeen = false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Expected a value for ${flag}`);
    if (flag === '--config' && config === undefined) config = value;
    else if (flag === '--out' && !outSeen) { out = value; outSeen = true; }
    else throw new Error(`Unknown or repeated option: ${flag}`);
  }
  return { config, out };
}

function csvCell(value: string | number | null): string {
  const content = value === null ? '' : String(value);
  return /[",\r\n]/.test(content) ? `"${content.replaceAll('"', '""')}"` : content;
}

async function main(): Promise<void> {
  const { config, out } = options(process.argv.slice(2));
  const bundle = config ? await loadConfigured(resolve(config)) : loadSynthetic();
  const view = buildReport(bundle);
  const report = view.operational;
  const measures = ['approvedParents', 'createdParents', 'openParents', 'incomingBugs',
    'commits', 'testTouchCommits', 'tokens', 'toolSpend'] as const;
  const columns = ['month', 'label', ...measures.flatMap(measure => [measure, `${measure}Status`])];
  const csv = [columns.join(','), ...report.monthly.map(row =>
    [row.month, row.label, ...measures.flatMap(measure => [row[measure], row.measureStatus[measure]])]
      .map(csvCell).join(','))].join('\n') + '\n';
  const evidence = {
    scope: report.scope, sourceKind: report.sourceKind, startDate: report.startDate,
    context: view.context ?? null,
    endDate: report.endDate, timezone: report.timezone, extractedAt: report.extractedAt,
    currency: report.currency, completenessAttestation: report.completenessAttestation,
    coverage: report.coverage, monthly: report.monthly, periods: report.periods, exclusions: report.exclusions,
    evidenceGaps: report.evidenceGaps, humanEffort: report.humanEffort,
    totalAiCost: report.totalAiCost, roi: report.roi,
  };
  const base = report.sourceKind === 'synthetic' ? 'api-team' :
    report.scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team-report';
  const directory = resolve(out);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of [
    [`${base}.html`, renderHtml(view)],
    [`${base}-monthly.csv`, csv],
    [`${base}-evidence.json`, JSON.stringify(evidence, null, 2) + '\n'],
  ]) {
    const path = join(directory, name);
    writeFileSync(path, content, 'utf8');
    console.log(path);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});