import type { Coverage } from './model.js';
import type { OperationalMonth, OperationalPeriod } from './aggregate.js';
import type { ReportView } from './report.js';

const escapeHtml = (value: unknown): string => String(value ?? '').replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const text = (value: unknown): string => escapeHtml(value);
const number = (value: number | null): string => value === null ? 'Unavailable' :
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const money = (value: number | null, currency: string): string =>
  value === null ? 'Unavailable' : `${text(currency)} ${number(value)}`;
const percent = (value: number | null): string => value === null ? 'Unavailable' :
  `${number(value * 100)}%`;
const cell = (value: string): string => `<td>${value}</td>`;
const headingCell = (value: string): string => `<th scope="row">${text(value)}</th>`;
const status = (value: Coverage['status']): string =>
  `<span class="status status-${text(value)}">${text(value)}</span>`;
const measure = (value: number | null, coverage: Coverage['status'], format = number): string =>
  coverage === 'unavailable' || value === null ? 'Unavailable' :
    `${format(value)}${coverage === 'partial' ? ' (partial)' : ''}`;
const issueCount = (types: Record<string, number> | null, kind: string): number | null =>
  types === null ? null : Object.hasOwn(types, kind) ? types[kind] : 0;

function comparison(label: string, key: keyof Pick<OperationalPeriod,
  'approvedParents' | 'incomingBugs' | 'commits' | 'testTouchCommits' | 'testTouchShare' | 'tokens' | 'toolSpend'>,
  before: OperationalPeriod, after: OperationalPeriod, format = number): string {
  const coverageKey = key === 'testTouchShare' ? 'testTouchShare' : key === 'testTouchCommits'
    ? 'testTouchCommits' : key;
  return `<tr>${headingCell(label)}${cell(measure(before[key], before.measureStatus[coverageKey], format))}` +
    `${cell(measure(after[key], after.measureStatus[coverageKey], format))}</tr>`;
}

function periodTable(rows: string, caption: string, periods: OperationalPeriod[]): string {
  if (periods.length !== 2) return '<p class="note">Comparison unavailable for fewer than two months.</p>';
  const months = (period: OperationalPeriod) =>
    (Number(period.endMonth.slice(0, 4)) - Number(period.startMonth.slice(0, 4))) * 12 +
    Number(period.endMonth.slice(5, 7)) - Number(period.startMonth.slice(5, 7)) + 1;
  const unequal = months(periods[0]) !== months(periods[1]);
  const label = (period: OperationalPeriod) =>
    unequal ? `${period.label} (${months(period)} months)` : period.label;
  return `<div class="table-scroll"><table><caption>${text(caption)}</caption><thead><tr>` +
    `<th scope="col">Measure</th><th scope="col">${text(label(periods[0]))}</th>` +
    `<th scope="col">${text(label(periods[1]))}</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function trend(monthly: OperationalMonth[], field: 'approvedParents' | 'tokens' | 'toolSpend',
  label: string, unit: string, coverage: 'approvedParents' | 'tokens' | 'toolSpend',
  periods: OperationalPeriod[], synthetic: boolean, scale = 1, detailsContent = ''): string {
  const values = monthly.map(row => {
    const value = row[field];
    return row.measureStatus[coverage] === 'unavailable' || value === null ? null : value / scale;
  });
  const rows = monthly.map((row, index) => `<tr>${headingCell(`${row.label} (${row.month})`)}` +
    `${cell(measure(values[index], row.measureStatus[coverage], value =>
      field === 'toolSpend' ? money(value, unit) : number(value)))}</tr>`).join('');
  return `<figure class="chart-card"><figcaption class="chart-head"><span class="chart-title">${text(label)}</span>` +
    `<span class="chart-hint">${text(unit)}</span></figcaption>` +
    `<div class="chart" data-field="${field}" data-scale="${scale}" data-unit="${text(unit === 'millions' ? 'million tokens' : unit)}" data-chart-label="${text(label)}"></div>` +
    `<div class="legend"><span><i class="raw"></i>monthly</span>${periods.length === 2 ?
      `<span><i class="prior-avg"></i>${text(periods[0].label)} avg</span>` +
      `<span><i class="recent-avg"></i>${text(periods[1].label)} avg</span>` +
      `<span><i class="split-marker"></i>${synthetic ? 'M7 split' : 'period boundary'}</span>` : ''}</div>` +
    `<details><summary>${text(label)} data table</summary><div class="table-shell"><table>` +
    `<caption>${text(label)} by month, ${text(unit)}</caption><thead><tr><th scope="col">Month</th>` +
    `<th scope="col">${text(label)}${field === 'toolSpend' ? ` (${text(unit)})` : ''}</th></tr></thead><tbody>${rows}</tbody></table></div>${detailsContent}</details></figure>`;
}

function gitTrend(monthly: OperationalMonth[], field: 'commits' | 'testTouchCommits', label: string,
  periods: OperationalPeriod[], synthetic: boolean): string {
  const rows = monthly.map(row => `<tr>${headingCell(`${row.label} (${row.month})`)}` +
    `${cell(measure(row[field], row.measureStatus[field]))}</tr>`).join('');
  return `<figure class="chart-card"><figcaption class="chart-head"><span class="chart-title">${text(label)}</span>` +
    '<span class="chart-hint">activity</span></figcaption>' +
    `<div class="chart" data-field="${field}"></div>` +
    `<div class="legend"><span><i class="raw"></i>monthly</span>${periods.length === 2 ?
      `<span><i class="split-marker"></i>${synthetic ? 'M7 split' : 'period boundary'}</span>` : ''}</div>` +
    `<details><summary>${text(label)} data table</summary><div class="table-shell"><table>` +
    `<caption>${text(label)} by month</caption><thead><tr><th scope="col">Month</th>` +
    `<th scope="col">${text(label)}</th></tr></thead><tbody>${rows}</tbody></table></div></details></figure>`;
}

function issueTrend(monthly: OperationalMonth[], kind: string | null, periods: OperationalPeriod[], synthetic: boolean,
  displayLabel?: string): string {
  const total = kind === null;
  const label = displayLabel ?? (total ? 'All created issues (total)' : kind);
  const rows = monthly.map(row => `<tr>${headingCell(`${row.label} (${row.month})`)}` +
    `${cell(measure(row.issueTypes === null ? null : total
      ? Object.values(row.issueTypes).reduce((sum, value) => sum + value, 0) : issueCount(row.issueTypes, kind),
    row.measureStatus.issueTypes))}</tr>`).join('');
  return `<figure class="chart-card">${displayLabel
    ? `<figcaption class="chart-head"><span class="chart-title">${text(label)}</span><span class="chart-hint">count</span></figcaption>`
    : `<figcaption class="chart-title">${text(label)}</figcaption>`}` +
    `<div class="chart" ${total ? 'data-total-issues="true"' : `data-type="${text(kind)}"`}${displayLabel
      ? ` data-chart-label="${text(label)}" data-unit="issues"` : ''}></div>` +
    `<div class="legend"><span><i class="raw"></i>monthly</span>` +
    (periods.length === 2 ? `<span><i class="prior-avg"></i>${text(periods[0].label)} avg</span>` +
      `<span><i class="recent-avg"></i>${text(periods[1].label)} avg</span>` +
      `<span><i class="split-marker"></i>${synthetic ? 'M7 split' : 'period boundary'}</span>` : '') +
    `</div><details><summary>${text(label)} data table</summary><div class="table-shell"><table>` +
    `<caption>${text(label)} by month${displayLabel ? ', count' : ''}</caption><thead><tr><th scope="col">Month</th><th scope="col">Created</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div></details></figure>`;
}

function tokenIssueComparison(monthly: OperationalMonth[], periods: OperationalPeriod[], synthetic: boolean): string {
  const issues = (row: OperationalMonth): number | null => row.issueTypes === null ||
    row.measureStatus.issueTypes === 'unavailable' ? null :
    Object.values(row.issueTypes).reduce((sum, value) => sum + value, 0);
  const base = monthly.find(row => row.tokens !== null && row.tokens > 0 &&
    row.measureStatus.tokens !== 'unavailable' && (issues(row) ?? 0) > 0);
  const baseTokens = base?.tokens ?? null;
  const baseIssues = base ? issues(base) : null;
  const indexed = (value: number | null, baseline: number | null): number | null =>
    value === null || baseline === null ? null : value / baseline * 100;
  const rows = monthly.map(row => {
    const issueTotal = issues(row);
    const tokens = row.measureStatus.tokens === 'unavailable' ? null : row.tokens;
    return `<tr>${headingCell(`${row.label} (${row.month})`)}` +
      `${cell(measure(tokens === null ? null : tokens / 1_000_000, row.measureStatus.tokens))}` +
      `${cell(measure(issueTotal, row.measureStatus.issueTypes))}` +
      `${cell(measure(indexed(tokens, baseTokens), row.measureStatus.tokens))}` +
      `${cell(measure(indexed(issueTotal, baseIssues), row.measureStatus.issueTypes))}</tr>`;
  }).join('');
  const baselineLabel = base ? `indexed to ${base.label} (${base.month}) = 100` :
    'index unavailable: no month has positive values for both measures';
  return `<figure class="chart-card"><figcaption class="chart-head"><span class="chart-title">Token use vs created issues</span>` +
    `<span class="chart-hint">index</span></figcaption>` +
    `<div class="chart" data-comparison="tokens-issues" data-base-month="${text(base?.month ?? '')}"></div>` +
    `<div class="legend"><span><i class="raw"></i>Token use</span><span><i class="comparison-issues"></i>Created issues</span>` +
    (periods.length === 2 ? `<span><i class="split-marker"></i>${synthetic ? 'M7 split' : 'period boundary'}</span>` : '') +
    `</div><details><summary>Token use vs created issues data table</summary><div class="table-shell"><table>` +
    `<caption>Token use vs created issues by month; ${baselineLabel}</caption>` +
    `<thead><tr><th scope="col">Month</th><th scope="col">Tokens (millions)</th><th scope="col">Created issues</th>` +
    `<th scope="col">Tokens (index)</th><th scope="col">Issues (index)</th></tr></thead><tbody>${rows}</tbody>` +
    `</table></div></details></figure>`;
}

function ledgerRow(row: OperationalMonth, currency: string, splitIndex: number | null): string {
  const values = [
    measure(row.approvedParents, row.measureStatus.approvedParents),
    measure(row.createdParents, row.measureStatus.createdParents),
    measure(row.openParents, row.measureStatus.openParents),
    measure(row.incomingBugs, row.measureStatus.incomingBugs),
    measure(row.commits, row.measureStatus.commits),
    measure(row.testTouchCommits, row.measureStatus.testTouchCommits),
    measure(row.tokens, row.measureStatus.tokens),
    measure(row.toolSpend, row.measureStatus.toolSpend, value => money(value, currency)),
  ];
  return `<tr data-period="${splitIndex === null ? 'all' : Number(row.label.slice(1)) <= splitIndex ? 'before' : 'after'}">` +
    `${headingCell(`${row.label} ${row.month}`)}${values.map(cell).join('')}</tr>`;
}

export function renderHtml(view: ReportView): string {
  const report = view.operational;
  const context = view.context;
  const supplied = (value: string | undefined): string => text(value ?? 'Not supplied');
  const repositoryLabels = context?.repositories?.length
    ? context.repositories.map(label => `<span class="repo-chip">${text(label)}</span>`).join('')
    : '<span class="context-missing">Not supplied</span>';
  const [before, after] = report.periods;
  const splitIndex = after ? report.monthly.findIndex(row => row.month === after.startMonth) : null;
  const period = `${report.startDate} to ${report.endDate}`;
  const usageRows = before && after ? comparison('Input + output tokens', 'tokens', before, after) +
    comparison('Test-touch share of eligible commits', 'testTouchShare', before, after, percent) : '';
  const impactRows = before && after ? comparison('Approved Stories and Tasks', 'approvedParents', before, after) +
    comparison('Incoming production bugs', 'incomingBugs', before, after) +
    comparison('Eligible commits (activity)', 'commits', before, after) : '';
  const issueTypes = [...new Set([...Object.keys(before?.issueTypes ?? {}),
    ...Object.keys(after?.issueTypes ?? {})])].sort();
  const issueRows = before && after ? issueTypes.map(kind => `<tr>${headingCell(kind)}` +
    `${cell(measure(issueCount(before.issueTypes, kind), before.measureStatus.issueTypes))}` +
    `${cell(measure(issueCount(after.issueTypes, kind), after.measureStatus.issueTypes))}</tr>`).join('') : '';
  const diagnostics = report.repositoryDiagnostics;
  const diagnosticRows: [string, number | null, (value: number | null) => string][] = [
    ['Lines added (churn)', diagnostics?.churn?.linesAdded ?? null, number],
    ['Lines deleted (churn)', diagnostics?.churn?.linesDeleted ?? null, number],
    ['Distinct contributors', diagnostics?.contributorCount ?? null, number],
    ['Median change size', diagnostics?.medianChangeSize ?? null, number],
    ['Mean change size', diagnostics?.meanChangeSize ?? null, number],
    ['Large multi-area change share', diagnostics?.largeChangeShare ?? null, percent],
    ['Test / source lines added', diagnostics?.testToSourceRatio ?? null, percent],
  ];
  const diagnosticCells = diagnosticRows.map(([label, value, format]) =>
    `<tr>${headingCell(label)}${cell(format(value))}</tr>`).join('');
  const costRows = before && after ? comparison('Recorded tool charges', 'toolSpend', before, after,
    value => money(value, report.currency)) : '';
  const periodTotal = (key: 'openParents' | 'missingStartTimes' | 'unknownProductionBugs'): string =>
    report.monthly.some(row => row[key] === null || row.measureStatus[key] === 'unavailable')
      ? 'Unavailable' : `${number(report.monthly.reduce((sum, row) => sum + (row[key] ?? 0), 0))}` +
        (report.monthly.some(row => row.measureStatus[key] === 'partial') ? ' (partial)' : '');
  const hasDetailedUsage = report.monthly.some(row => row.usage?.byModel !== null && row.usage?.byModel !== undefined);
  const modelRows = Object.entries(report.monthly.reduce<Record<string, {
    inputTokens: number; cachedInputTokens: number; outputTokens: number;
    tokens: number; failed: number; retries: number;
  }>>(
    (totals, row) => {
      for (const [name, item] of Object.entries(row.usage?.byModel ?? {})) {
        const current = totals[name] ?? {
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokens: 0, failed: 0, retries: 0,
        };
        current.inputTokens += item.inputTokens;
        current.cachedInputTokens += item.cachedInputTokens;
        current.outputTokens += item.outputTokens;
        current.tokens += item.tokens;
        current.failed += item.failed;
        current.retries += item.retries;
        totals[name] = current;
      }
      return totals;
    }, Object.create(null) as Record<string, {
      inputTokens: number; cachedInputTokens: number; outputTokens: number;
      tokens: number; failed: number; retries: number;
    }>))
    .map(([name, item]) => `<tr>${headingCell(name)}${cell(number(item.inputTokens))}` +
      `${cell(number(item.cachedInputTokens))}${cell(number(item.outputTokens))}${cell(number(item.tokens))}` +
      `${cell(number(item.failed))}${cell(number(item.retries))}</tr>`).join('');
  const usageComposition = `<h3>Usage composition</h3>` + (hasDetailedUsage
    ? `<p class="note">Cached input is a subset of input tokens. Failed attempts and retries are included when recorded.</p><div class="table-scroll"><table><caption>Model breakdown across reporting windows</caption><thead><tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cached input</th><th scope="col">Output</th><th scope="col">Tokens</th><th scope="col">Failed</th><th scope="col">Retries</th></tr></thead><tbody>${modelRows || '<tr><td colspan="7">No detailed usage records available.</td></tr>'}</tbody></table></div>`
    : `<p class="note">Model, input/output/cache, retry and work-item breakdown unavailable. ${report.monthly.some(row => row.tokens !== null)
      ? 'Only monthly token totals are recorded.' : 'Monthly token totals are unavailable.'}</p>`);
  const sourceRows = report.coverage.map(entry => `<tr>${headingCell(entry.source)}${cell(status(entry.status))}` +
    `${cell(number(entry.eligible))}${cell(number(entry.extracted))}${cell(number(entry.linked))}` +
    `${cell(number(entry.excluded))}${cell(number(entry.missing))}${cell(text(entry.reason || 'No reported gap'))}</tr>`).join('');
  const definitions = report.definitions.map(entry => `<tr>${headingCell(entry.metric)}` +
    `${cell(text(entry.definition))}${cell(text(entry.source))}${cell(status(entry.coverage))}</tr>`).join('');
  const gapRows = report.evidenceGaps.map(gap => `<tr>${headingCell(gap.metric)}${cell(text(gap.reason))}</tr>`).join('');
  const examples = view.examples.map(item => `<tr>${headingCell(item.id)}${cell(text(item.kind))}` +
    `${cell(text(item.treatment))}</tr>`).join('');
  const migration = view.migration.result;
  // Keep the separate migration case available to restore later.
  const showMigrationCase = false;
  const ledger = report.monthly.map(row => ledgerRow(row, report.currency, splitIndex)).join('');
  const total = (key: 'approvedParents' | 'commits' | 'incomingBugs' | 'tokens' | 'toolSpend'): string =>
    report.monthly.some(row => row[key] === null || row.measureStatus[key] === 'unavailable') ? 'Unavailable' :
      number(report.monthly.reduce((sum, row) => sum + (row[key] ?? 0), 0)) +
      (report.monthly.some(row => row.measureStatus[key] === 'partial') ? ' (partial)' : '');
  const recordedSpend = total('toolSpend');
  const splitMonth = splitIndex === null ? null : report.monthly[splitIndex]?.month;
  const types = [...new Set(report.monthly.flatMap(row => Object.keys(row.issueTypes ?? {})))].sort();
  const typeLegend = types.map((kind, index) => `<span><i class="swatch" style="background:${
    ['#4aa3ff', '#7c5cff', '#3fb950', '#e3a008', '#f85149', '#56d4dd', '#db61a2', '#93a1b1'][index % 8]
  }"></i>${text(kind)}</span>`).join('');
  const typeColumns = types.map(kind => `<th scope="col">${text(kind)}</th>`).join('');
  const typeData = report.monthly.map(row => `<tr>${headingCell(`${row.label} (${row.month})`)}` +
    types.map(kind => cell(measure(issueCount(row.issueTypes, kind),
      row.measureStatus.issueTypes))).join('') + '</tr>').join('');
  const embedded = JSON.stringify(view).replaceAll('&', '\\u0026').replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Impact Report | ${text(report.scope)}</title>
<style>
:root{--bg:#0f1419;--panel:#171d26;--panel-2:#1f2733;--border:#2a3441;--text:#e6edf3;--muted:#a8b5c3;--accent:#4aa3ff;--good:#3fb950;--bad:#f85149;--focus:#e3a008;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;color:var(--text);background:var(--bg);font-family:"Avenir Next","Segoe UI",sans-serif;line-height:1.5}a{color:var(--accent)}a:focus-visible,summary:focus-visible,select:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
header{background:linear-gradient(180deg,#131a24,#0f1419);padding:34px max(24px,calc((100vw - 1320px)/2));border-bottom:1px solid var(--border)}.eyebrow{color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em}h1{margin:8px 0 6px;max-width:900px;font-size:28px;line-height:1.2}header p,.sub{color:var(--muted);margin:0;font-size:14px}
.top{border-bottom:1px solid var(--border);background:var(--panel)}.top .shell{max-width:1320px;margin:auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:9px 24px}.brand{font-weight:700;margin-right:auto}.top nav{display:flex;flex-wrap:wrap;gap:6px 18px}.top a{font-size:12px;text-decoration:none;color:var(--muted)}.top a:hover{text-decoration:underline;color:var(--text)}
main.shell{max-width:1320px;margin:0 auto;padding:30px 24px 72px}section{margin:0 0 42px;scroll-margin-top:16px}h2{font-size:20px;margin:0 0 4px}h3{font-size:15px;margin:22px 0 8px}p{max-width:90ch;margin:8px 0 13px}.note,.section-head p{color:var(--muted);font-size:13px}.section-head{margin-bottom:16px}.section-head p{margin:2px 0 0}.meta{color:var(--muted);font-size:13px}
#evidence>p{max-width:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px}.kpi,.chart-card,.type-card{background:var(--panel);border:1px solid var(--border);border-radius:8px;min-width:0}.kpi{min-height:100px;padding:16px 18px}.kpi-label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase}.kpi-value{font-size:28px;font-weight:600;margin:7px 0 3px;font-variant-numeric:tabular-nums}.kpi-meta{color:var(--muted);font-size:12px}.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.chart-card,.type-card{padding:16px;margin:0}.chart-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.chart-title{font-size:15px;font-weight:600}.chart-hint{color:var(--muted);font-size:11px;padding:3px 8px;border-radius:999px;background:var(--panel-2)}.chart{height:220px;width:100%;margin-top:8px}.type-chart{height:320px}.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:11px;margin-top:6px}.legend span{display:inline-flex;align-items:center;gap:5px}.legend i:not(.swatch){display:inline-block;width:18px;border-top:3px solid var(--accent)}.legend i.comparison-issues{border-color:#56d4dd}.legend i.prior-avg{border-color:#7c5cff;border-top-style:dashed}.legend i.recent-avg{border-color:#e3a008;border-top-style:dashed}.legend i.split-marker{border-color:var(--bad);border-top-style:dashed}.swatch{width:11px;height:11px;display:inline-block;border-radius:2px}.tooltip{position:fixed;display:none;pointer-events:none;background:#0b0f14;border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:12px;box-shadow:0 10px 26px #0008;z-index:50;max-width:260px}
.context-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:16px 0}.context-panel{min-width:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px 18px}.context-panel h3{margin:0 0 8px;color:var(--muted);font-size:12px}.context-panel p{margin:0;font-size:13px;overflow-wrap:anywhere}.context-panel .context-secondary{margin-top:8px;color:var(--muted)}.repo-chips{display:flex;flex-wrap:wrap;gap:6px}.repo-chip{font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:var(--panel-2);overflow-wrap:anywhere}.context-missing{color:var(--muted)}.profile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px;margin:14px 0}.profile-field{padding:12px 0;border-top:1px solid var(--border);min-width:0}.profile-field dt{font-weight:600;font-size:13px}.profile-field dd{margin:4px 0 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}.profile-field dd+dt{margin-top:10px}.profile-updated{font-size:12px;color:var(--muted)}.cost-note{color:#e3a008;font-weight:650}.details-grid,.split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-items:start}.details-grid>div{min-width:0}.mini{font-variant-numeric:tabular-nums}
.table-shell,.table-scroll{overflow:auto;max-width:100%;border:1px solid var(--border);border-radius:8px;background:var(--panel)}table{border-collapse:collapse;width:100%;min-width:520px;font-size:13px;font-variant-numeric:tabular-nums}caption{text-align:left;font-weight:600;padding:10px 12px;color:var(--text);white-space:normal}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}thead th{position:sticky;top:0;background:#131a24;color:var(--muted);font-size:11px;text-transform:uppercase;white-space:nowrap}tbody th{font-weight:600}tbody tr:hover>*{background:var(--panel-2)}tbody tr[data-period="after"]>th{box-shadow:inset 3px 0 0 var(--bad)}td.num,th.num{text-align:right}.status{font-weight:650;text-transform:capitalize}.status-partial{color:#e3a008}.status-unavailable{color:#bdabff}.status-available{color:#69d878}.chart-card details{margin-top:12px}.chart-card summary{color:var(--accent);cursor:pointer;font-size:12px}.chart-card .table-shell{margin-top:10px}
.ledger-control{display:flex;gap:12px;align-items:center;margin:14px 0;flex-wrap:wrap}.ledger-control select{font:inherit;border:1px solid var(--border);padding:6px 10px;background:var(--panel);color:var(--text)}#ledger table{min-width:880px}.cost-composition{margin-top:18px}.cost-composition summary{color:var(--accent);cursor:pointer;font-size:13px;font-weight:600}.cost-composition .table-scroll{margin-top:10px}.separate{border-top:2px solid var(--border);padding-top:28px}.financials{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin:20px 0}.financials div{background:var(--panel);padding:16px}.financials strong{font-size:1.2rem;font-variant-numeric:tabular-nums;display:block}.financials span{color:var(--muted);font-size:12px}footer{padding:24px max(24px,calc((100vw - 1320px)/2)) 60px;color:var(--muted);font-size:12px;border-top:1px solid var(--border)}
@media(max-width:800px){header{padding:16px 18px}h1{font-size:23px;margin:4px 0}header .sub{font-size:12px}main.shell{padding:14px 14px 56px}.top .shell{padding:6px 14px}.top .brand{display:none}.top nav{width:100%;gap:4px 14px;flex-wrap:nowrap;overflow-x:auto;white-space:nowrap}.top nav a{padding:3px 0;flex:none}.chart-grid,.split,.details-grid,.context-grid,.profile-grid{grid-template-columns:1fr}.context-grid{gap:10px}.context-panel{padding:12px 14px}.financials{grid-template-columns:repeat(2,minmax(0,1fr))}.type-chart{height:260px}}
@media(max-width:390px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kpi{padding:12px}.kpi-value{font-size:18px;overflow-wrap:anywhere}.financials strong{font-size:1rem}}
@page{size:A4 portrait;margin:14mm 12mm}
@media print{:root{--bg:#fff;--panel:#fff;--panel-2:#f4f6f8;--border:#c9d1d9;--text:#11161c;--muted:#54606d;color-scheme:light}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:#fff;color:#11161c;font-size:11pt}header{background:#fff;padding:0 0 10px;margin-bottom:12px;border-bottom:2px solid #11161c}.top,.tooltip,.ledger-control{display:none!important}main.shell{max-width:none;padding:0}.kpis{grid-template-columns:repeat(3,1fr);gap:10px}.chart-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.chart{height:150px}.type-chart{height:200px}section,.kpi,.chart-card,.type-card{break-inside:avoid;page-break-inside:avoid}.table-shell,.table-scroll{overflow:visible}thead{display:table-header-group}thead th{position:static;background:#f4f6f8;color:#11161c}tr{break-inside:avoid}tr[hidden]{display:table-row}.separate{break-before:page}svg text{fill:#54606d!important}svg line.grid-line{stroke:#d0d7de!important}}
</style></head><body>
<header><div class="eyebrow">AI-assisted development | Output report</div><h1>AI Impact Report</h1><p class="sub">${text(report.scope)} · ${report.sourceKind === 'synthetic' ? 'Synthetic example, not a live team result' : 'Configured sources (live status unverified)'} · ${text(period)} · ${text(report.timezone)} · extracted ${text(report.extractedAt)}</p></header>
<div class="top"><div class="shell"><span class="brand">AI / delivery evidence</span><nav aria-label="Report sections"><a href="#overview">Overview</a><a href="#profile">Report profile</a><a href="#impact">Impact</a><a href="#issue-volume">Issue types</a><a href="#utilization">Utilization</a><a href="#git">Git</a><a href="#cost">Cost</a><a href="#ledger">Ledger</a><a href="#evidence">Evidence</a>${showMigrationCase ? '<a href="#migration">Migration case</a>' : ''}</nav></div></div>
<main class="shell">
<section id="overview"><h2>Overview</h2><div class="context-grid"><div class="context-panel"><h3>Team and service</h3><p>${supplied(context?.description)}</p></div><div class="context-panel"><h3>AI use and context</h3><p>${supplied(context?.aiUse)}</p><p class="context-secondary">${supplied(context?.concurrentChanges)}</p></div><div class="context-panel"><h3>Repository evidence</h3><div class="repo-chips">${repositoryLabels}</div></div></div><div class="kpis"><div class="kpi"><div class="kpi-label">Months covered</div><div class="kpi-value">${number(report.monthly.length)}</div><div class="kpi-meta">${text(period)}</div></div><div class="kpi"><div class="kpi-label">Approved Stories and Tasks</div><div class="kpi-value">${total('approvedParents')}</div><div class="kpi-meta">first release approval</div></div><div class="kpi"><div class="kpi-label">Git commits</div><div class="kpi-value">${total('commits')}</div><div class="kpi-meta">eligible, non-merge</div></div><div class="kpi"><div class="kpi-label">Token use</div><div class="kpi-value">${total('tokens')}</div><div class="kpi-meta">input + output tokens</div></div><div class="kpi"><div class="kpi-label">Recorded tool spend</div><div class="kpi-value">${recordedSpend === 'Unavailable' ? recordedSpend : `${recordedSpend} ${text(report.currency)}`}</div><div class="kpi-meta">not total AI cost</div></div>${report.sourceKind === 'synthetic' && splitMonth ? `<div class="kpi"><div class="kpi-label">More systematic use from</div><div class="kpi-value">${text(splitMonth)}</div><div class="kpi-meta">synthetic M7 boundary</div></div>` : ''}</div></section>
<section id="profile"><h2>Report profile</h2><p class="profile-updated">Report updated ${supplied(context?.updatedAt)} · Data extracted ${text(report.extractedAt.slice(0, 10))}</p><dl class="profile-grid"><div class="profile-field"><dt>Owner and description</dt><dd>${supplied(context?.owner)}. ${supplied(context?.description)}</dd></div><div class="profile-field"><dt>Scope and use</dt><dd>${supplied(context?.includedWork)} Exclusions: ${supplied(context?.excludedWork)}</dd></div><div class="profile-field"><dt>Actual use and context</dt><dd>${supplied(context?.aiUse)} ${supplied(context?.concurrentChanges)}</dd></div><div class="profile-field"><dt>Question and comparison</dt><dd>${supplied(context?.question)} ${text(period)}. ${before && after ? `${text(before.label)} versus ${text(after.label)}.` : 'Comparison unavailable.'}</dd></div><div class="profile-field"><dt>Measures and findings</dt><dd>Approved Stories and Tasks: ${total('approvedParents')}; incoming production bugs: ${total('incomingBugs')}. Delivery time and human effort: ${report.leadTime === null || report.humanEffort === null ? 'unassessed' : 'available'}.</dd></div><div class="profile-field"><dt>Resources and financial claims</dt><dd>Recorded tool spend: ${recordedSpend === 'Unavailable' ? recordedSpend : `${recordedSpend} ${text(report.currency)}`}. Total AI cost and API-team ROI: unassessed. ${supplied(context?.resourceLimits)} Controls: ${supplied(context?.controls)}</dd></div></dl></section>
<section id="impact"><div class="section-head"><h2>Impact</h2><p>Delivery and quality signals, not AI effects.</p></div><div class="chart-grid">${trend(report.monthly,'approvedParents','Approved Stories and Tasks','items','approvedParents',report.periods,report.sourceKind === 'synthetic')}<div class="chart-card">${periodTable(impactRows,'Accepted output, incoming bugs and repository activity',report.periods)}</div></div><p class="note">Incoming bugs count creation events. Without release links and follow-up windows they are not an escaped-defect rate. Eligible commits and test-touch counts describe repository activity, not effort or productivity.</p>
<div class="details-grid"><div><h3>Issue type mix</h3>${periodTable(issueRows,'Created tickets by type and period',report.periods)}</div><div><h3>Repository diagnostics</h3><p class="note">Activity diagnostics only; neither person-hours nor AI impact. Large changes exceed 100 lines across two file areas; churn is not move-discounted. The ratio uses test and source lines added, not all files.</p><div class="table-scroll"><table><caption>Optional observations across eligible commits</caption><thead><tr><th scope="col">Measure</th><th scope="col">Observed</th></tr></thead><tbody>${diagnosticCells}</tbody></table></div></div></div>
<div class="details-grid"><div><h3>Counting choices</h3><p class="mini">Children excluded: ${number(report.exclusions.children)} · emergency fixes: ${number(report.exclusions.emergency)} · duplicate approvals: ${number(report.exclusions.duplicateApprovals)} · merges: ${number(report.exclusions.mergeCommits)} · bots: ${number(report.exclusions.botCommits)} · ambiguous commit links: ${number(report.exclusions.ambiguousCommitLinks)} · unlinked commits: ${number(report.exclusions.unlinkedCommitLinks)}</p></div><div><h3>Work in progress and missing timestamps</h3><p class="mini">Open Stories and Tasks: ${periodTotal('openParents')} · missing start times: ${periodTotal('missingStartTimes')} · unknown production bugs: ${periodTotal('unknownProductionBugs')}. Lead time: ${number(report.leadTime)}. Human effort: ${report.humanEffort === null ? 'unassessed' : number(report.humanEffort)}.</p></div></div></section>
<section id="issue-volume"><h2>Issues per month <span class="meta">by issue type</span></h2><p class="note">Created tickets by type. Unavailable months have no bars; counts are not approved output.</p><figure class="type-card"><figcaption class="chart-title">Issue volume by type</figcaption><svg class="chart type-chart" id="type-chart" role="group" aria-label="Monthly created issues stacked by type; data table follows"></svg><div class="legend" id="type-legend">${typeLegend}</div><details><summary>Issue type data table</summary><div class="table-shell"><table><caption>Created tickets by month and type</caption><thead><tr><th scope="col">Month</th>${typeColumns}</tr></thead><tbody>${typeData}</tbody></table></div></details></figure></section>
${types.length ? `<section id="category-trends"><h2>Issues per month by category</h2><p class="note">Created-ticket counts by type, including an all-issues total. Monthly trends are descriptive.</p><div class="chart-grid">${[null, ...types].map(kind => issueTrend(report.monthly, kind, report.periods, report.sourceKind === 'synthetic')).join('')}</div></section>` : ''}
<section id="utilization"><div class="section-head"><h2>Utilization</h2><p>Token consumption and created issues, by month. The comparison indexes both to the first month with positive values for both measures (100). Sharing a month does not link tokens to a task or establish an AI effect.</p></div><div class="chart-grid">${trend(report.monthly,'tokens','Input + output tokens','millions','tokens',report.periods,report.sourceKind === 'synthetic',1_000_000,usageComposition)}${tokenIssueComparison(report.monthly,report.periods,report.sourceKind === 'synthetic')}</div>
<h3>Period comparison</h3>${periodTable(usageRows,'Use and test-touch activity, combined period counts and shares',report.periods)}
</section>
<section id="git"><h2>Git activity</h2><p class="note">Eligible commits and unit-test-touch commits are activity signals, not measured effort or AI effects.</p><div class="chart-grid">${gitTrend(report.monthly,'commits','Eligible commits',report.periods,report.sourceKind === 'synthetic')}${gitTrend(report.monthly,'testTouchCommits','Test-touch commits',report.periods,report.sourceKind === 'synthetic')}</div></section>
<section id="cost"><div class="section-head"><h2>Cost</h2><p>Recorded ${text(report.currency)} tool spend is not total AI cost.</p></div><div class="chart-grid">${trend(report.monthly,'toolSpend','Recorded tool charges',report.currency,'toolSpend',report.periods,report.sourceKind === 'synthetic')}<div class="chart-card">${periodTable(costRows,'Recorded consumption, subscriptions and other charges',report.periods)}</div></div><p class="note">Recorded charges include subscriptions and other billed items; monthly token totals alone cannot explain them or establish a per-token price.</p><p class="cost-note">Total AI cost: unassessed. API-team ROI: unassessed. Human review, correction, enablement, governance and platform costs are unpriced; tool spend per approved Story or Task is not a return on investment.</p><details class="cost-composition"><summary>Monthly cost composition and token use</summary>${report.sourceKind === 'synthetic' ? '<p class="note">The subscription and consumption split is illustrative, not a reconstructed invoice or a price computed from tokens. Model, input/output and cache breakdowns are unavailable for this case.</p>' : ''}<div class="table-scroll"><table><caption>Monthly billing mix, token use and spend per approved Story or Task</caption><thead><tr><th scope="col">Month</th><th scope="col">Tokens (millions)</th><th scope="col">Charge categories</th><th scope="col">Recorded tool charges (${text(report.currency)})</th><th scope="col">Spend / approved Story or Task (${text(report.currency)})</th></tr></thead><tbody>${report.monthly.map(row => `<tr>${headingCell(row.label)}${cell(measure(row.tokens === null ? null : row.tokens / 1_000_000, row.measureStatus.tokens))}${cell(row.billingCategories === null ? 'Unavailable' : Object.entries(row.billingCategories).map(([category, amount]) => `${text(category)}: ${money(amount, report.currency)}`).join('; ') || 'No recorded charges')}${cell(measure(row.toolSpend, row.measureStatus.toolSpend, value => money(value, report.currency)))}${cell(row.toolSpendPerApprovedParent === null ? 'Unavailable' : money(row.toolSpendPerApprovedParent, report.currency))}</tr>`).join('')}</tbody></table></div></details></section>
<section id="ledger"><div class="section-head"><h2>Monthly ledger</h2><p>Counts follow first approval or event month in ${text(report.timezone)}.</p></div><div class="ledger-control"><label for="period-filter">Period</label><select id="period-filter"><option value="all">All months</option>${before && after ? `<option value="before">${text(before.label)}</option><option value="after">${text(after.label)}</option>` : ''}</select><span id="row-count" role="status" aria-live="polite">${report.monthly.length} ${report.monthly.length === 1 ? 'month' : 'months'}</span></div>
<div class="table-shell"><table id="monthly-table"><caption>Monthly observed measures; unavailable and partial values are marked</caption><thead><tr><th scope="col">Window</th><th scope="col" class="num">Approved</th><th scope="col" class="num">Created</th><th scope="col" class="num">Open</th><th scope="col" class="num">Bugs</th><th scope="col" class="num">Commits</th><th scope="col" class="num">Test-touch</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Tool spend</th></tr></thead><tbody>${ledger}</tbody></table></div></section>
<section id="evidence"><h2>Evidence</h2><p>Scope: ${text(report.scope)}. Selection: first qualifying release approval per eligible Story or Task in complete monthly windows ${text(period)}. ${report.sourceKind === 'synthetic' ? 'Earlier reporting period (M1-M6) and more-systematic-use period (M7-M12) both record AI tool consumption and charges, but AI use per change is unknown. This is not an AI-free baseline or an AI-effect estimate.' : 'Configured period boundaries describe time only; no AI adoption event is documented.'}</p><p>Source method: ${text(report.completenessAttestation)}</p><p>Extraction: ${text(report.extractedAt)}; calendar timezone: ${text(report.timezone)}. Omitted historical effort, start events and release-linked defect follow-up are not treated as zero.</p>
<h3>Source coverage</h3><div class="table-scroll"><table><caption>Eligible, extracted, linked, excluded and missing records by source</caption><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Eligible</th><th scope="col">Extracted</th><th scope="col">Linked</th><th scope="col">Excluded</th><th scope="col">Missing</th><th scope="col">Method / gap</th></tr></thead><tbody>${sourceRows}</tbody></table></div>
<h3>Evidence gaps</h3><div class="table-scroll"><table><caption>Unassessed measures and reasons</caption><thead><tr><th scope="col">Measure</th><th scope="col">Reason</th></tr></thead><tbody>${gapRows}</tbody></table></div>
<h3>Definitions</h3><div class="table-scroll"><table><caption>Metric inclusion rules and source status</caption><thead><tr><th scope="col">Metric</th><th scope="col">Definition</th><th scope="col">Source</th><th scope="col">Coverage</th></tr></thead><tbody>${definitions}</tbody></table></div>
<h3>Selected source records</h3><p class="note">${report.sourceKind === 'synthetic' ? 'Synthetic examples' : 'Source records'} illustrate inclusion; record identifiers are text, never external links.</p><div class="table-scroll"><table><caption>Example parent, child and open ticket treatments</caption><thead><tr><th scope="col">ID</th><th scope="col">Type</th><th scope="col">Treatment</th></tr></thead><tbody>${examples || '<tr><td colspan="3">No selected examples in these sources.</td></tr>'}</tbody></table></div></section>
<section id="actions"><h2>Next actions</h2><div class="table-scroll"><table><caption>Evidence collection owners and checks</caption><thead><tr><th scope="col">Owner</th><th scope="col">Action</th><th scope="col">Condition</th><th scope="col">Review Date</th></tr></thead><tbody>${view.actions.map(item => `<tr>${headingCell(item.owner)}${cell(text(item.action))}${cell(text(item.condition))}${cell(text(item.reviewDate))}</tr>`).join('')}</tbody></table></div></section>
${showMigrationCase ? `<section class="separate" id="migration"><h2>Separate migration case</h2><p>${text(view.migration.scope)}. Assumed verified USD worksheet for ${text(migration.period)}. This case cannot be added to, or financially compared with, the API team's ${text(report.currency)} record.</p><div class="financials"><div><span>Avoided supplier cost</span><strong>${money(migration.avoidedCost,migration.currency)}</strong></div><div><span>Incremental total cost</span><strong>${money(migration.totalCost,migration.currency)}</strong></div><div><span>Net benefit</span><strong>${money(migration.netBenefit,migration.currency)}</strong></div><div><span>Financial ROI</span><strong>${percent(migration.roi)}</strong></div></div><p>Verification and overlap checks: ${view.migration.assumptions.map(text).join('; ')}. Excluded duplicate saved-hours claim: ${migration.excludedClaims.map(text).join(', ') || 'none'}. ${migration.gaps.map(text).join('; ')}</p></section>` : ''}
</main><footer class="shell">${report.sourceKind === 'synthetic' ? 'Synthetic evidence only. ' : ''}No causal attribution or statistical significance is asserted.</footer>
<script type="application/json" id="report-data">${embedded}</script>
<div class="tooltip" id="tooltip" role="status"></div>
<script>
const data=JSON.parse(document.getElementById('report-data').textContent);
const months=data.operational.monthly;
const splitIndex=data.operational.periods.length===2?months.findIndex(row=>row.month===data.operational.periods[1].startMonth):null;
const filter=document.getElementById('period-filter');
const rows=[...document.querySelectorAll('#monthly-table tbody tr')];
filter.addEventListener('change',()=>{let count=0;for(const row of rows){row.hidden=filter.value!=='all'&&row.dataset.period!==filter.value;if(!row.hidden)count++}document.getElementById('row-count').textContent=count+(count===1?' month':' months')});
const ns='http://www.w3.org/2000/svg';
const colors=['#4aa3ff','#7c5cff','#3fb950','#e3a008','#f85149','#56d4dd','#db61a2','#93a1b1'];
const tip=document.getElementById('tooltip');
function element(parent,name,attrs,label){const node=document.createElementNS(ns,name);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));if(label!==undefined)node.textContent=label;parent.appendChild(node);return node}
function showTip(event,label){tip.textContent=label;tip.style.display='block';const box=tip.getBoundingClientRect();tip.style.left=Math.max(4,Math.min(innerWidth-box.width-4,(event.clientX||0)+12))+'px';tip.style.top=Math.max(4,Math.min(innerHeight-box.height-4,(event.clientY||0)+12))+'px'}
function bindTip(node,label){node.setAttribute('tabindex','0');node.setAttribute('role','img');node.setAttribute('aria-label',label);node.addEventListener('pointermove',event=>showTip(event,label));node.addEventListener('focus',event=>{const box=event.target.getBoundingClientRect();showTip({clientX:box.left,clientY:box.top},label)});node.addEventListener('pointerleave',()=>tip.style.display='none');node.addEventListener('blur',()=>tip.style.display='none')}
function axes(svg,width,height,pad,max,labels,x){const plotHeight=height-pad.top-pad.bottom;const compact=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1});for(const ratio of [0,.5,1]){const y=pad.top+plotHeight*(1-ratio);element(svg,'line',{x1:pad.left,y1:y,x2:width-pad.right,y2:y,stroke:'#243040',class:'grid-line'});element(svg,'text',{x:pad.left-5,y:y+4,'text-anchor':'end',fill:'#a8b5c3','font-size':10},max>=10000?compact.format(max*ratio):String(Math.round(max*ratio)))}const step=Math.max(1,Math.ceil(labels.length/7));labels.forEach((label,index)=>{if(index%step===0||index===labels.length-1)element(svg,'text',{x:x(index),y:height-6,'text-anchor':'middle',fill:'#a8b5c3','font-size':10},label.slice(5))})}
function splitLine(svg,x,top,bottom){element(svg,'line',{x1:x,y1:top,x2:x,y2:bottom,stroke:'#f85149','stroke-width':1.6,'stroke-dasharray':'5 3',class:'split-line'})}
function drawTypeChart(){
  const svg=document.getElementById('type-chart');
  const width=Math.max(240,svg.clientWidth||900),height=svg.clientHeight||320,pad={left:38,right:12,top:12,bottom:28};
  svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.replaceChildren();
  const types=[...new Set(months.flatMap(row=>Object.keys(row.issueTypes||{})))].sort();
  const valid=months.filter(row=>row.issueTypes!==null&&row.measureStatus.issueTypes!=='unavailable');
  if(!valid.length||!types.length){element(svg,'text',{x:20,y:40,fill:'#a8b5c3'},'Issue type data unavailable');return}
  const plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom;
  const max=Math.max(1,...valid.map(row=>Object.values(row.issueTypes).reduce((sum,value)=>sum+value,0)));
  const x=index=>pad.left+(index+.5)*plotWidth/months.length;
  axes(svg,width,height,pad,max,months.map(row=>row.month),x);
  months.forEach((row,index)=>{if(row.issueTypes===null||row.measureStatus.issueTypes==='unavailable')return;
    let stack=0;types.forEach((type,typeIndex)=>{const value=Object.hasOwn(row.issueTypes,type)?row.issueTypes[type]:0;if(value<=0)return;
      const barHeight=value/max*plotHeight;
      const rect=element(svg,'rect',{x:x(index)-plotWidth/months.length*.35,y:pad.top+plotHeight-(stack+value)/max*plotHeight,width:plotWidth/months.length*.7,height:barHeight,fill:colors[typeIndex%colors.length],opacity:.9});
      bindTip(rect,row.month+' '+type+': '+value+(row.measureStatus.issueTypes==='partial'?' (partial)':''));stack+=value})});
  if(splitIndex!==null)splitLine(svg,pad.left+splitIndex*plotWidth/months.length,pad.top,pad.top+plotHeight)
}
function drawTrend(container){
  const field=container.dataset.field;
  const type=container.dataset.type;
  const isTotal=container.hasAttribute('data-total-issues');
  const label=container.dataset.chartLabel??(isTotal?'All created issues (total)':type??field);
  const coverage=isTotal||type!==undefined?'issueTypes':field;
  const scale=Number(container.dataset.scale||1);
  const values=months.map(row=>row.measureStatus[coverage]==='unavailable'?null:isTotal||type!==undefined
    ?row.issueTypes===null?null:isTotal?Object.values(row.issueTypes).reduce((sum,value)=>sum+value,0):Object.hasOwn(row.issueTypes,type)?row.issueTypes[type]:0
    :row[field]===null?null:row[field]/scale);
  const svg=element(container,'svg',{width:'100%',height:'100%',role:'group','aria-label':label+' monthly chart; data table follows'});
  const width=Math.max(240,container.clientWidth||500),height=container.clientHeight||220,pad={left:40,right:12,top:12,bottom:28};
  svg.setAttribute('viewBox','0 0 '+width+' '+height);
  const present=values.filter(value=>value!==null);
  if(!present.length){element(svg,'text',{x:20,y:40,fill:'#a8b5c3'},'Data unavailable');return}
  const max=Math.max(1,...present)*1.1,plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom;
  const x=index=>pad.left+(months.length===1?plotWidth/2:index*plotWidth/(months.length-1));
  const y=value=>pad.top+plotHeight*(1-value/max);
  axes(svg,width,height,pad,max,months.map(row=>row.month),x);
  for(let start=0;start<values.length;){if(values[start]===null){start++;continue}
    let end=start;while(end+1<values.length&&values[end+1]!==null)end++;
    if(end>start)element(svg,'polyline',{points:values.slice(start,end+1).map((value,index)=>x(start+index)+','+y(value)).join(' '),fill:'none',stroke:'#4aa3ff','stroke-width':2,'stroke-linejoin':'round'});
    start=end+1}
  if(splitIndex!==null){for(const [start,end,color] of [[0,splitIndex,'#7c5cff'],[splitIndex,months.length,'#e3a008']]){
    const observed=values.slice(start,end).filter(value=>value!==null);if(!observed.length)continue;
    const average=observed.reduce((sum,value)=>sum+value,0)/observed.length;
    element(svg,'line',{x1:x(start),y1:y(average),x2:x(Math.min(end-1,months.length-1)),y2:y(average),stroke:color,'stroke-width':1.5,'stroke-dasharray':'5 3'})}
    splitLine(svg,(x(splitIndex-1)+x(splitIndex))/2,pad.top,pad.top+plotHeight)}
  values.forEach((value,index)=>{if(value===null)return;
    const point=element(svg,'circle',{cx:x(index),cy:y(value),r:4,fill:'#4aa3ff'});
    bindTip(point,months[index].month+' '+label+': '+value.toLocaleString()+(container.dataset.unit?' '+container.dataset.unit:'')+(months[index].measureStatus[coverage]==='partial'?' (partial)':''))})
}
function drawComparison(container){
  const base=months.find(row=>row.month===container.dataset.baseMonth);
  const baseIssues=base?.issueTypes===null?null:Object.values(base?.issueTypes||{}).reduce((sum,value)=>sum+value,0);
  const svg=element(container,'svg',{width:'100%',height:'100%',role:'group','aria-label':'Token use and created issues indexed to a shared month; data table follows'});
  const width=Math.max(240,container.clientWidth||500),height=container.clientHeight||220,pad={left:40,right:12,top:12,bottom:28};
  svg.setAttribute('viewBox','0 0 '+width+' '+height);
  if(!base||!base.tokens||!baseIssues){element(svg,'text',{x:20,y:40,fill:'#a8b5c3'},'Comparison unavailable');return}
  const series=[
    {label:'Token use',color:'#4aa3ff',unit:'million tokens',coverage:'tokens',baseline:base.tokens,
      raw:months.map(row=>row.measureStatus.tokens==='unavailable'?null:row.tokens===null?null:row.tokens/1_000_000),scale:1_000_000},
    {label:'Created issues',color:'#56d4dd',unit:'issues',coverage:'issueTypes',baseline:baseIssues,
      raw:months.map(row=>row.measureStatus.issueTypes==='unavailable'||row.issueTypes===null?null:Object.values(row.issueTypes).reduce((sum,value)=>sum+value,0)),scale:1}
  ];
  const indexed=series.map(item=>item.raw.map(value=>value===null?null:value*item.scale/item.baseline*100));
  const present=indexed.flat().filter(value=>value!==null);
  const max=Math.max(100,...present)*1.1,plotWidth=width-pad.left-pad.right,plotHeight=height-pad.top-pad.bottom;
  const x=index=>pad.left+(months.length===1?plotWidth/2:index*plotWidth/(months.length-1));
  const y=value=>pad.top+plotHeight*(1-value/max);
  axes(svg,width,height,pad,max,months.map(row=>row.month),x);
  indexed.forEach((values,seriesIndex)=>{
    const item=series[seriesIndex];
    for(let start=0;start<values.length;){if(values[start]===null){start++;continue}
      let end=start;while(end+1<values.length&&values[end+1]!==null)end++;
      if(end>start)element(svg,'polyline',{points:values.slice(start,end+1).map((value,index)=>x(start+index)+','+y(value)).join(' '),fill:'none',stroke:item.color,'stroke-width':2,'stroke-linejoin':'round'});
      start=end+1}
    values.forEach((value,index)=>{if(value===null)return;
      const point=element(svg,'circle',{cx:x(index),cy:y(value),r:4,fill:item.color});
      bindTip(point,months[index].month+' '+item.label+': '+Number(item.raw[index]).toLocaleString()+' '+item.unit+' (index '+value.toFixed(1)+')'+(months[index].measureStatus[item.coverage]==='partial'?' (partial)':''))})
  });
  if(splitIndex!==null)splitLine(svg,(x(splitIndex-1)+x(splitIndex))/2,pad.top,pad.top+plotHeight)
}
function redraw(){drawTypeChart();for(const container of document.querySelectorAll('.chart[data-field],.chart[data-type],.chart[data-total-issues]')){container.replaceChildren();drawTrend(container)}for(const container of document.querySelectorAll('.chart[data-comparison]')){container.replaceChildren();drawComparison(container)}}
redraw();let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(redraw,150)});window.addEventListener('beforeprint',redraw);window.addEventListener('afterprint',redraw);if(window.matchMedia){const print=window.matchMedia('print');if(print.addEventListener)print.addEventListener('change',redraw)}
</script>
</body></html>`;
}