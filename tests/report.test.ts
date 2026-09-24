import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSynthetic } from '../src/adapters/synthetic.js';
import { buildReport } from '../src/report.js';
import { renderHtml } from '../src/html.js';
import type { SourceBundle, UsageEvent } from '../src/model.js';

const detailedEvent: UsageEvent = {
  id: 'detailed-1', provenance: { source: 'test', recordId: 'detailed-1' },
  at: '2025-09-18T10:00:00Z', model: 'example-model', inputTokens: 100,
  cachedInputTokens: 40, outputTokens: 20, attempt: 1, outcome: 'success',
};

const withoutUsage = (source: SourceBundle): SourceBundle => ({ ...source, usage: undefined,
  coverage: source.coverage.map(entry => entry.source === 'usage'
    ? { source: 'usage', status: 'unavailable', eligible: 0, extracted: 0,
      linked: 0, excluded: 0, missing: 0, reason: 'No usage records in this window fixture.' } : entry),
});

test('the default overview is a synthetic report profile, not a decision verdict', () => {
  const view = buildReport(loadSynthetic());
  const html = renderHtml(view);
  assert.equal(Object.hasOwn(view, 'decision'), false);
  assert.match(html, /<h2>Overview<\/h2>[\s\S]*Team and service[\s\S]*AI use and context[\s\S]*Repository evidence/);
  assert.match(html, /<h2>Report profile<\/h2>/);
  assert.match(html, /Engineering lead \(fictional\)|Engineering lead/);
  assert.match(html, /Synthetic API commit history/);
  assert.match(html, /2026-09-01/);
  assert.doesNotMatch(html, /id="decision"|href="#decision"|class="mobile-decision"|<h2>Decision<\/h2>|hold broad rollout/i);
  assert.match(html, /126[\s\S]*168|168[\s\S]*126/);
  assert.match(html, /AI (effect|contribution)[\s\S]*unassessed|AI effects/);
  assert.match(html, /API.team ROI[\s\S]*unassessed/i);
  assert.match(html, /24[\s\S]*24/);
  assert.match(html, /M1.M6[\s\S]*M7.M12/);
  for (const heading of ['Overview', 'Report profile', 'Utilization', 'Impact', 'Cost', 'Evidence', 'Definitions', 'Monthly ledger', 'Next actions']) {
    assert.match(html, new RegExp(`<h[1-6][^>]*>${heading}</h[1-6]>`, 'i'));
  }
  assert.ok(html.indexOf('id="actions"') > html.indexOf('id="evidence"'));
  assert.ok(html.indexOf('<section id="profile">') < html.indexOf('<section id="impact">'));
  assert.ok(html.indexOf('<section id="impact">') < html.indexOf('<section id="issue-volume">'));
  assert.match(html, /href="#profile">Report profile<\/a><a href="#impact">Impact<\/a>/);
});

test('configured windows show actual periods, row count and no invented AI adoption event', () => {
  const source = loadSynthetic();
  const html = renderHtml(buildReport({ ...withoutUsage(source), sourceKind: 'configured', endDate: '2026-10-31',
    completenessAttestation: 'Configured full-month window.' }));
  assert.match(html, /M1-M7[\s\S]*M8-M14/);
  assert.match(html, /id="row-count"[^>]*>14 months/);
  assert.match(html, /<option value="after">M8-M14<\/option>/);
  assert.doesNotMatch(html, /more systematic AI use|increased AI use|M7 split/);
});

test('a one-month report marks comparisons unavailable without fictitious zeroes', () => {
  const source = loadSynthetic();
  const html = renderHtml(buildReport({ ...withoutUsage(source), context: undefined,
    sourceKind: 'configured', endDate: '2025-09-30',
    completenessAttestation: 'Configured full-month window.' }));
  assert.match(html, /comparison unavailable[^<]*fewer than two months/i);
  assert.match(html, /id="row-count"[^>]*>1 month</);
  assert.doesNotMatch(html, /M1-M6|M7-M12|more systematic AI use/i);
});

test('thirteen months with one approval per month do not claim increased accepted work', () => {
  const source = loadSynthetic();
  const firstTicket = source.tickets?.[0];
  const firstCharge = source.charges?.[0];
  const firstCommit = source.commits?.[0];
  assert.ok(firstTicket);
  assert.ok(firstCharge);
  assert.ok(firstCommit);
  const months = Array.from({ length: 13 }, (_, index) =>
    new Date(Date.UTC(2025, 8 + index, 1)).toISOString().slice(0, 7));
  const bundle = { ...withoutUsage(source), sourceKind: 'configured' as const, endDate: '2026-09-30',
    tickets: months.flatMap((month, index) => [
      { ...firstTicket, id: `rate-${index}`, createdAt: `${month}-02T09:00:00Z`,
        approvals: [{ at: `${month}-20T10:00:00Z`, releaseId: `release-${index}` }] },
      { ...firstTicket, id: `bug-${index}`, type: 'Bug', status: 'unknown' as const, production: true,
        createdAt: `${month}-11T09:00:00Z`, approvals: [] },
    ]),
    commits: months.map((month, index) => ({ ...firstCommit, hash: `rate-commit-${index}`,
      at: `${month}-12T12:00:00Z` })),
    charges: months.map((month, index) => ({ ...firstCharge, id: `rate-charge-${index}`,
      billId: `rate-bill-${index}`, month, amount: 100, billTotal: 100 })),
  };
  const view = buildReport(bundle);
  assert.deepEqual(view.operational.periods.map(period => period.approvedParents), [6, 7]);
  assert.equal(view.operational.comparisons.approvedParentsRelativeChange, 0);
  assert.equal(view.operational.comparisons.commitsRelativeChange, 0);
  assert.equal(view.operational.comparisons.incomingBugsRelativeChange, 0);
  assert.equal(Object.hasOwn(view, 'decision'), false);
  assert.deepEqual(view.operational.periods.map(period => period.approvedParents), [6, 7]);
  assert.match(renderHtml(view), /<th scope="col">M1-M6 \(6 months\)<\/th><th scope="col">M7-M13 \(7 months\)<\/th>/);

  const partial = buildReport({ ...bundle, coverage: bundle.coverage.map(entry =>
    entry.source === 'tickets' ? { ...entry, status: 'partial' as const, reason: 'Tickets incomplete.' } : entry) });
  assert.equal(partial.operational.comparisons.approvedParentsRelativeChange, null);
  assert.equal(partial.operational.periods[0].measureStatus.approvedParents, 'partial');
  const partialSpend = buildReport({ ...bundle, coverage: bundle.coverage.map(entry =>
    entry.source === 'charges' ? { ...entry, status: 'partial' as const, reason: 'Billing incomplete.' } : entry) });
  assert.equal(partialSpend.operational.periods[0].measureStatus.toolSpend, 'partial');
});

test('dashboard follows the blueprint hierarchy with a stacked chart and print layout', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.match(html, /<header[^>]*>[\s\S]*<h1>/);
  assert.doesNotMatch(html, /ai-banner|More systematic AI use from <b>/);
  assert.match(html, /class="kpis"/);
  assert.match(html, /class="chart-grid"/);
  assert.match(html, /<svg[^>]*id="type-chart"/);
  assert.match(html, /class="legend"/);
  assert.match(html, /class="table-shell"[\s\S]*id="monthly-table"/);
  assert.match(html, /@media print/);
  assert.match(html, /#evidence\s*>\s*p\s*\{max-width:none\}/);
  assert.equal((html.match(/class="chart" data-field="/g) ?? []).length, 5);
  assert.match(html, /<caption>Created tickets by month and type<\/caption>/);
  assert.match(html, /<th scope="row">M1 \(2025-09\)<\/th><td>4<\/td>/);
  assert.match(html, /M1-M6 already includes AI use/);
  assert.match(html, /class="split-marker"/);
  assert.doesNotMatch(html, /class="chart" data-field="[^"]+" aria-hidden="true"/);
  assert.doesNotMatch(html, /\bp\s*[<=>]\s*0\.\d|Welch|statistically significant/i);
  assert.doesNotMatch(html, /<a\s+[^>]*href="https?:\/\//i);
});

test('overview comes first and SVG charts expose a group rather than a hidden image', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.ok(html.indexOf('<h2>Overview</h2>') < html.indexOf('id="issue-volume"'));
  assert.ok(html.indexOf('<h2>Report profile</h2>') < html.indexOf('id="issue-volume"'));
  assert.match(html, /id="type-chart" role="group"/);
  assert.doesNotMatch(html, /id="type-chart" role="img"/);
  assert.match(html, /role:'group'/);
});

test('configured reports do not inherit fictional context or confuse updates with extraction', () => {
  const source = loadSynthetic();
  const html = renderHtml(buildReport({ ...withoutUsage(source), context: undefined,
    sourceKind: 'configured', endDate: '2025-09-30', extractedAt: '2026-11-01T00:00:00Z' }));
  assert.match(html, /Team and service[\s\S]*Not supplied/);
  assert.match(html, /AI use and context[\s\S]*Not supplied/);
  assert.match(html, /Repository evidence[\s\S]*Not supplied/);
  assert.doesNotMatch(html, /Synthetic API commit history|Agent-supported endpoint preparation|2026-11-01<\/dd>/);
  assert.match(html, /Data extracted[^<]*2026-11-01/);
  assert.doesNotMatch(html, /Synthetic examples illustrate inclusion/);
  assert.match(html, /Source records illustrate inclusion/);
});

test('narrow overview KPIs allow long values to wrap inside their tiles', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.match(html, /@media\(max-width:390px\)/);
  assert.match(html, /\.kpi-value\{font-size:18px;overflow-wrap:anywhere\}/);
});

test('overview totals qualify partial ticket and Git coverage and context text is inert', () => {
  const source = loadSynthetic();
  const hostile = '</script><script>alert(1)</script>';
  source.context = { ...source.context, description: hostile, repositories: ['Synthetic API history'] };
  source.coverage = source.coverage.map(entry => entry.source === 'tickets' || entry.source === 'commits'
    ? { ...entry, status: 'partial', reason: 'Incomplete export.' } : entry);
  const html = renderHtml(buildReport(source));
  assert.match(html, /Approved Stories and Tasks<\/div><div class="kpi-value">294 \(partial\)/);
  assert.match(html, /Git commits<\/div><div class="kpi-value">1,200 \(partial\)/);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('overview distinguishes incomplete totals from known zero and unavailable', () => {
  const source = loadSynthetic();
  const partial = renderHtml(buildReport({ ...source, tickets: [], commits: [],
    coverage: source.coverage.map(entry => entry.source === 'tickets' || entry.source === 'commits'
      ? { ...entry, status: 'partial' as const, reason: 'Import incomplete.' } : entry),
  }));
  assert.match(partial, /Approved Stories and Tasks<\/div><div class="kpi-value">0 \(partial\)/);
  assert.match(partial, /Git commits<\/div><div class="kpi-value">0 \(partial\)/);
  const absent = renderHtml(buildReport({ ...source, commits: undefined,
    coverage: source.coverage.map(entry => entry.source === 'commits'
      ? { ...entry, status: 'unavailable' as const, reason: 'Missing Git export.' } : entry),
  }));
  assert.match(absent, /Git commits<\/div><div class="kpi-value">Unavailable/);
});

test('the report names approved Stories and Tasks without hiding the counting rule', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.match(html, /<span class="chart-title">Approved Stories and Tasks<\/span>/);
  assert.match(html, /<caption>Approved Stories and Tasks by month, items<\/caption>/);
  assert.match(html, /Spend \/ approved Story or Task/);
  assert.match(html, /Eligible Story or Task at first release approval; no children, defects or emergency fixes/);
});

test('migration case is temporarily hidden from the report and navigation', () => {
  for (const source of [loadSynthetic(), { ...loadSynthetic(), sourceKind: 'configured' as const }]) {
    const html = renderHtml(buildReport(source));
    const displayed = html.split('</main>')[0];
    assert.doesNotMatch(displayed, /id="migration"|href="#migration"|Separate migration case|USD 35,000|75%/);
    assert.match(html, /<script type="application\/json" id="report-data">[\s\S]*"migration":\{/);
  }
});

test('untrusted adapter fields and serialized data are inert, including script terminators', () => {
  const source = loadSynthetic();
  const hostile = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';
  source.scope = hostile;
  source.completenessAttestation = hostile;
  source.coverage[0].reason = hostile;
  source.tickets![0].type = hostile;
  source.usage = [{ ...detailedEvent, model: hostile }];
  source.charges![0].category = hostile;
  const html = renderHtml(buildReport(source));
  assert.ok(!html.includes('<script>alert('));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('</script><script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /https?:\/\/(?:[^"\s]*jira|[^"\s]*git)/i);
});

test('ledger and trend alternatives expose monthly counts and source coverage', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.match(html, /<table[^>]*>[\s\S]*M12[\s\S]*<\/table>/);
  assert.match(html, /2026-03/);
  assert.match(html, /filter/i);
  assert.match(html, /input tokens|cached input/i);
  assert.match(html, /retries/i);
  assert.match(html, /excluded|duplicate approvals/i);
  assert.match(html, /missing start/i);
  assert.match(html, /source coverage/i);
});

test('model usage table separates input, output, cached input and failed attempts', () => {
  const source = loadSynthetic();
  source.usage = [detailedEvent];
  source.coverage = source.coverage.map(entry => entry.source === 'usage'
    ? { ...entry, status: 'partial', extracted: 1, eligible: 12, missing: 11,
      reason: 'Only one observed event in this fixture.' } : entry);
  const html = renderHtml(buildReport(source));
  const table = html.split('<caption>Model breakdown across reporting windows</caption>')[1]?.split('</table>')[0];
  assert.ok(table);
  for (const column of ['Input', 'Cached input', 'Output', 'Tokens', 'Failed', 'Retries']) {
    assert.match(table, new RegExp(`<th scope="col">${column}</th>`));
  }
  assert.match(table, /<th scope="row">example-model<\/th>/);
  const tokenCard = html.split('data-field="tokens"')[1]?.split('</figure>')[0];
  assert.ok(tokenCard);
  assert.match(tokenCard, /<details><summary>Input \+ output tokens data table<\/summary>[\s\S]*<h3>Usage composition<\/h3>[\s\S]*<caption>Model breakdown across reporting windows<\/caption>/);
});

test('monthly totals show no invented model, token-category, retry or task detail', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  const utilization = html.split('<section id="utilization">')[1]?.split('<section id="git">')[0];
  assert.ok(utilization);
  assert.match(utilization, /model.*unavailable|breakdown.*unavailable/i);
  assert.doesNotMatch(utilization, /<th scope="row">example-model<\/th>|linked attempts/i);
  assert.match(utilization, /Input \+ output tokens by month, millions/);
  assert.match(utilization, /Token use vs created issues by month/);
  const tokenCard = utilization.split('data-field="tokens"')[1]?.split('</figure>')[0];
  assert.ok(tokenCard);
  assert.match(tokenCard, /<details><summary>Input \+ output tokens data table<\/summary>[\s\S]*<h3>Usage composition<\/h3>[\s\S]*Model, input\/output\/cache, retry and work-item breakdown unavailable/);
  assert.equal((utilization.match(/<h3>Usage composition<\/h3>/g) ?? []).length, 1);
  const absent = loadSynthetic();
  absent.usage = undefined;
  absent.coverage = absent.coverage.map(entry => entry.source === 'usage'
    ? { ...entry, status: 'unavailable', eligible: 0, extracted: 0, linked: 0,
      reason: 'No usage export.' } : entry);
  const missing = renderHtml(buildReport(absent));
  assert.match(missing, /Input \+ output tokens by month, millions/);
  assert.match(missing, /No usage export\.|Unavailable/);
});

test('utilization contrasts monthly issue volume and token totals without task attribution', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  const utilization = html.split('<section id="utilization">')[1]?.split('<section id="git">')[0];
  assert.ok(utilization);
  assert.ok(utilization.indexOf('data-field="tokens"') < utilization.indexOf('data-comparison="tokens-issues"'));
  assert.match(utilization, /<span class="chart-title">Input \+ output tokens<\/span><span class="chart-hint">millions<\/span>/);
  assert.match(utilization, /<span class="chart-title">Token use vs created issues<\/span>/);
  assert.match(utilization, /<caption>Input \+ output tokens by month, millions<\/caption>/);
  assert.match(utilization, /data-scale="1000000" data-unit="million tokens"/);
  assert.match(utilization, /data-comparison="tokens-issues" data-base-month="2025-09"/);
  assert.match(utilization, /<caption>Token use vs created issues by month; indexed to M1 \(2025-09\) = 100<\/caption>/);
  assert.match(utilization, /<th scope="row">M1 \(2025-09\)<\/th><td>8<\/td><td>22<\/td><td>100<\/td><td>100<\/td>/);
  assert.match(utilization, /sharing a month does not link tokens to a task/i);
  assert.doesNotMatch(utilization, /Link and token coverage|linked attempts|class="detail-list"/i);
});

test('comparison uses the first shared positive month and leaves absent baselines unavailable', () => {
  const view = buildReport(loadSynthetic());
  view.operational.monthly[0].tokens = 0;
  const html = renderHtml(view);
  const utilization = html.split('<section id="utilization">')[1]?.split('<section id="git">')[0];
  assert.ok(utilization);
  assert.match(utilization, /data-comparison="tokens-issues" data-base-month="2025-10"/);
  assert.match(utilization, /indexed to M2 \(2025-10\) = 100/);

  for (const month of view.operational.monthly) {
    month.tokens = null;
    month.measureStatus.tokens = 'unavailable';
  }
  const missing = renderHtml(view).split('<section id="utilization">')[1]?.split('<section id="git">')[0];
  assert.ok(missing);
  assert.match(missing, /data-comparison="tokens-issues" data-base-month=""/);
  assert.match(missing, /index unavailable: no month has positive values for both measures/);
  assert.match(missing, /<th scope="row">M1 \(2025-09\)<\/th><td>Unavailable<\/td><td>22<\/td><td>Unavailable<\/td>/);
});

test('impact detail includes issue-type mix and repository diagnostics without inventing observations', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.match(html, /Issue type mix/);
  assert.match(html, /<th scope="row">Story<\/th>/);
  assert.match(html, /<th scope="row">Bug<\/th>/);
  assert.match(html, /Repository diagnostics/);
  assert.match(html, /Mean change size[\s\S]*Unavailable/);
});

test('issue types retain monthly trend cards as well as the stacked volume chart', () => {
  const html = renderHtml(buildReport(loadSynthetic()));
  assert.match(html, /id="type-chart"/);
  assert.match(html, /id="category-trends"/);
  assert.match(html, /data-type="Story"/);
  assert.match(html, /data-type="Bug"/);
  assert.match(html, /<caption>Story by month<\/caption>[\s\S]*?<th scope="row">M7 \(2026-03\)<\/th><td>13<\/td>/);
  assert.match(html, /<caption>Bug by month<\/caption>[\s\S]*?<th scope="row">M7 \(2026-03\)<\/th><td>3<\/td>/);
});

test('a real All issues type stays separate from the generated 22-issue total', () => {
  const source = loadSynthetic();
  const firstTicket = source.tickets?.[0];
  assert.ok(firstTicket);
  const tickets = Array.from({ length: 21 }, (_, index) => ({ ...firstTicket,
    id: `story-${index}` }));
  const html = renderHtml(buildReport({ ...withoutUsage(source), sourceKind: 'configured', endDate: '2025-09-30',
    tickets: [...tickets, { ...firstTicket, id: 'real-all-issues', type: 'All issues',
      status: 'unknown', approvals: [] }],
  }));
  assert.match(html, /<figcaption class="chart-title">All created issues \(total\)<\/figcaption>/);
  assert.match(html, /<figcaption class="chart-title">All issues<\/figcaption>/);
  assert.equal((html.match(/<figcaption class="chart-title">All issues<\/figcaption>/g) ?? []).length, 1);
  assert.match(html, /class="chart" data-total-issues="true"/);
  assert.match(html, /class="chart" data-type="All issues"/);
  assert.match(html, /<caption>All issues by month<\/caption>[\s\S]*?<th scope="row">M1 \(2025-09\)<\/th><td>1<\/td>/);
  assert.match(html, /<caption>All created issues \(total\) by month<\/caption>[\s\S]*?<th scope="row">M1 \(2025-09\)<\/th><td>22<\/td>/);
  assert.doesNotMatch(html, /type==='All issues'/);
});

test('a real All created issues type and prototype-like types retain distinct chart totals', () => {
  const source = loadSynthetic();
  const firstTicket = source.tickets?.[0];
  assert.ok(firstTicket);
  const tickets = ['__proto__', 'constructor', 'toString', 'All created issues'].map((type, index) => ({
    ...firstTicket, id: `type-${index}`, type, status: 'unknown' as const, approvals: [],
  })).concat([{ ...firstTicket, id: 'proto-next-month', type: '__proto__', status: 'unknown' as const,
    approvals: [], createdAt: '2025-10-02T12:00:00Z' }]);
  const html = renderHtml(buildReport({ ...withoutUsage(source), sourceKind: 'configured', endDate: '2025-10-31', tickets }));
  const data = JSON.parse(html.match(/<script type="application\/json" id="report-data">([^<]+)<\/script>/)?.[1] ?? 'null');
  assert.deepEqual(data.operational.monthly[0].issueTypes,
    JSON.parse('{"__proto__":1,"constructor":1,"toString":1,"All created issues":1}'));
  for (const type of ['__proto__', 'constructor', 'toString', 'All created issues']) {
    assert.match(html, new RegExp(`<div class="chart" data-type="${type}"></div>`));
    assert.match(html, new RegExp(`<caption>${type} by month</caption>[\\s\\S]*?<th scope="row">M1 \\(2025-09\\)</th><td>1</td>`));
  }
  assert.equal((html.match(/<figcaption class="chart-title">All created issues<\/figcaption>/g) ?? []).length, 1);
  assert.match(html, /<figcaption class="chart-title">All created issues \(total\)<\/figcaption>/);
  assert.match(html, /<caption>All created issues \(total\) by month<\/caption>[\s\S]*?<th scope="row">M1 \(2025-09\)<\/th><td>4<\/td>/);
  assert.match(html, /<caption>constructor by month<\/caption>[\s\S]*?<th scope="row">M2 \(2025-10\)<\/th><td>0<\/td>/);
  assert.match(html, /<caption>All created issues \(total\) by month<\/caption>[\s\S]*?<th scope="row">M2 \(2025-10\)<\/th><td>1<\/td>/);
  assert.match(html, /<th scope="col">__proto__<\/th>/);
  assert.match(html, /<th scope="row">__proto__<\/th><td>1<\/td>/);
  assert.match(html, /class="chart" data-total-issues="true"/);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('observed Git diagnostics appear only as aggregates without contact or path details', () => {
  const source = loadSynthetic();
  const first = source.commits?.[0];
  assert.ok(first);
  const html = renderHtml(buildReport({ ...source, commits: [
    { ...first, hash: 'first', paths: ['src/api.ts'], changeSize: 10,
      linesAdded: 10, linesDeleted: 0, testLinesAdded: 0, sourceLinesAdded: 10,
      contributorId: 'private@example.org' },
    { ...first, hash: 'second', paths: ['tests/a.test.ts', 'src/api.ts'],
      changeSize: 120, linesAdded: 40, linesDeleted: 80, testLinesAdded: 10, sourceLinesAdded: 30,
      contributorId: 'other@example.org' },
  ] }));
  assert.match(html, /Median change size<\/th><td>65<\/td>/);
  assert.match(html, /Large multi-area change share<\/th><td>50%<\/td>/);
  assert.match(html, /Test \/ source lines added<\/th><td>25%<\/td>/);
  assert.doesNotMatch(html, /private@example\.org|other@example\.org|src\/api\.ts|tests\/a\.test\.ts/);
});

test('missing sources remain unavailable rather than turning into favorable zeroes', () => {
  const source = loadSynthetic();
  source.usage = undefined;
  source.charges = undefined;
  source.coverage = source.coverage.map(entry =>
    entry.source === 'usage' || entry.source === 'charges'
      ? { ...entry, status: 'unavailable', reason: 'Export not supplied' } : entry);
  const html = renderHtml(buildReport(source));
  assert.match(html, /Export not supplied/);
  assert.match(html, /Unavailable/);
  assert.match(html, /API.team ROI[\s\S]*unassessed/i);
});

test('absent ticket coverage does not display open work or missing starts as zero', () => {
  const source = loadSynthetic();
  source.tickets = undefined;
  source.coverage = source.coverage.map(entry => entry.source === 'tickets'
    ? { ...entry, status: 'unavailable', reason: 'Tickets not supplied' } : entry);
  const html = renderHtml(buildReport(source));
  assert.match(html, /Open Stories and Tasks: Unavailable/);
  assert.match(html, /missing start times: Unavailable/);
});

test('prototype-like model labels and hostile coverage status do not corrupt markup', () => {
  const source = loadSynthetic();
  source.usage = [{ ...detailedEvent, model: '__proto__' },
    { ...detailedEvent, id: 'detailed-2', provenance: { source: 'test', recordId: 'detailed-2' },
      model: 'constructor' }];
  source.coverage[0].status = 'available" onmouseover="alert(3)' as 'available';
  const html = renderHtml(buildReport(source));
  assert.match(html, /<th scope="row">__proto__<\/th>/);
  assert.match(html, /<th scope="row">constructor<\/th>/);
  assert.ok(!html.includes('onmouseover="alert(3)"'));
});