import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, countApprovedParents } from '../src/aggregate.js';
import { loadSynthetic } from '../src/adapters/synthetic.js';
import { isMonthlyUsage } from '../src/model.js';
import type { Commit, SourceBundle, Ticket } from '../src/model.js';
import { validateBundle } from '../src/validate.js';

const ticket = (id: string, overrides: Partial<Ticket>): Ticket => ({
  id, provenance: { source: 'test', recordId: id }, type: 'Story', status: 'approved',
  createdAt: '2026-02-01T00:00:00Z',
  approvals: [{ at: '2026-03-02T00:00:00Z', releaseId: 'release-1' }],
  ...overrides,
});

const withoutUsage = (source: SourceBundle): SourceBundle => ({ ...source, usage: undefined,
  coverage: source.coverage.map(entry => entry.source === 'usage'
    ? { source: 'usage', status: 'unavailable', eligible: 0, extracted: 0,
      linked: 0, excluded: 0, missing: 0, reason: 'Usage not in this comparison fixture.' } : entry),
});

test('counts each eligible parent only in its first approval month', () => {
  const approvals = countApprovedParents([
    ticket('parent', { approvals: [
      { at: '2026-03-02T00:00:00Z', releaseId: 'release-1' },
      { at: '2026-04-02T00:00:00Z', releaseId: 'release-2' },
    ] }),
    ticket('child', { parentId: 'parent' }),
    ticket('emergency', { emergency: true }),
    ticket('open', { status: 'open', approvals: [] }),
  ], 'UTC');
  assert.equal(approvals.get('2026-03'), 1);
  assert.equal(approvals.get('2026-04') ?? 0, 0);
});

test('first approval uses the selected timezone rather than the UTC month', () => {
  assert.deepEqual([...countApprovedParents([
    ticket('boundary', { approvals: [{ at: '2026-03-01T00:30:00Z', releaseId: 'r' }] }),
  ], 'America/Los_Angeles')], [['2026-02', 1]]);
});

test('all twelve monthly rows and combined period totals match the appendix', () => {
  const report = aggregate(loadSynthetic());
  assert.deepEqual(report.monthly.map(row => [row.label, row.approvedParents, row.commits,
    row.testTouchCommits, row.incomingBugs, row.tokens, row.toolSpend]), [
    ['M1', 18, 100, 12, 4, 8_000_000, 80],
    ['M2', 22, 100, 14, 5, 9_000_000, 90],
    ['M3', 20, 100, 15, 3, 10_000_000, 100],
    ['M4', 24, 100, 16, 4, 11_000_000, 110],
    ['M5', 19, 100, 14, 5, 10_000_000, 100],
    ['M6', 23, 100, 19, 3, 12_000_000, 120],
    ['M7', 24, 100, 20, 3, 12_000_000, 120],
    ['M8', 27, 100, 22, 5, 14_000_000, 140],
    ['M9', 25, 100, 24, 4, 15_000_000, 150],
    ['M10', 30, 100, 25, 3, 16_000_000, 160],
    ['M11', 28, 100, 27, 5, 16_000_000, 160],
    ['M12', 34, 100, 32, 4, 17_000_000, 170],
  ]);
  assert.deepEqual(report.periods.map(row => [row.label, row.approvedParents, row.commits,
    row.testTouchCommits, row.testTouchShare, row.incomingBugs, row.tokens, row.toolSpend]), [
    ['M1-M6', 126, 600, 90, 90 / 600, 24, 60_000_000, 600],
    ['M7-M12', 168, 600, 150, 150 / 600, 24, 90_000_000, 900],
  ]);
  assert.equal(report.comparisons.approvedParentsRelativeChange, 168 / 126 - 1);
  assert.equal(report.comparisons.testTouchSharePercentagePoints, (150 / 600 - 90 / 600) * 100);
});

test('a fourteen-month configured window compares every reported month in adjacent halves', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...withoutUsage(source), sourceKind: 'configured', endDate: '2026-10-31' });
  assert.equal(report.monthly.length, 14);
  assert.deepEqual(report.periods.map(row => [row.label, row.startMonth, row.endMonth]), [
    ['M1-M7', '2025-09', '2026-03'], ['M8-M14', '2026-04', '2026-10'],
  ]);
  assert.equal(report.periods[0].approvedParents, 150);
  assert.equal(report.periods[1].approvedParents, 144);
});

test('a single month has no invented comparison period or relative change', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...withoutUsage(source), sourceKind: 'configured', endDate: '2025-09-30' });
  assert.deepEqual(report.periods, []);
  assert.equal(report.comparisons.approvedParentsRelativeChange, null);
  assert.equal(report.comparisons.testTouchSharePercentagePoints, null);
});

test('operational monthly usage and spend agree with the accounting breakdown and leave ROI unassessed', () => {
  const report = aggregate(loadSynthetic());
  const march = report.monthly[6];
  assert.equal(march.tokens, 12_000_000);
  assert.equal(march.usage?.attempts, null);
  assert.equal(march.usage?.byModel, null);
  assert.equal(march.usage?.workItemLinks, null);
  assert.deepEqual(march.billingCategories, { subscription: 30, consumption: 90 });
  assert.equal(march.toolSpendPerApprovedParent, 5);
  assert.equal(report.totalAiCost, null);
  assert.equal(report.roi, null);
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'totalAiCost' && /review|correction/i.test(gap.reason)));
});

test('a period rejects token totals that exceed safe integer precision', () => {
  const source = loadSynthetic();
  const rollups = source.usage?.filter(isMonthlyUsage);
  assert.ok(rollups);
  const usage = rollups.map((record, index) => ({ ...record,
    tokens: index === 0 ? Number.MAX_SAFE_INTEGER : index === 1 ? 2 : 0 }));
  assert.throws(() => aggregate({ ...source, usage }), /tokens.*(safe|precision|overflow)/i);
});

test('created issue mix, open parents and missing approvals remain distinct', () => {
  const report = aggregate(loadSynthetic());
  const march = report.monthly[6];
  assert.deepEqual({ ...march.issueTypes }, { Story: 13, Task: 12, 'Sub-task': 1, Bug: 3 });
  assert.equal(march.createdParents, 25);
  assert.equal(march.openParents, 1);
  assert.equal(march.missingApproval, 0);
  assert.equal(march.missingStartTimes, 24);
  assert.equal(report.exclusions.duplicateApprovals, 1);
  assert.equal(report.exclusions.children, 1);
  assert.equal(march.commitLinks?.linked, 100);
  assert.equal(report.exclusions.bugsWithUnknownReleaseLinkage, 48);
  assert.equal('unlinkedBugs' in report.exclusions, false);
  assert.equal(report.escapedDefects, null);
  assert.equal(report.leadTime, null);
  assert.equal(report.humanEffort, null);
  assert.equal(report.releaseDiagnostics, null);
  assert.equal(report.repositoryDiagnostics, null);
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'repositoryDiagnostics' && gap.reason.includes('churn')));
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'releaseDiagnostics' && gap.reason.includes('history')));
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'leadTime' && gap.reason.includes('start')));
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'humanEffort'));
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'escapedDefects'));
  assert.equal(report.coverage.find(entry => entry.source === 'historical-effort')?.status, 'unavailable');
  assert.ok(report.definitions.some(entry => entry.metric === 'testTouchShare' && entry.source === 'commits'));
  assert.ok(report.definitions.some(entry => entry.metric === 'humanEffort' && entry.coverage === 'unavailable'));
  assert.equal(report.startDate, '2025-09-01');
  assert.equal(report.endDate, '2026-08-31');
});

test('prototype-like issue types survive monthly and period grouping without changing totals', () => {
  const source = loadSynthetic();
  const firstTicket = source.tickets?.[0];
  assert.ok(firstTicket);
  const tickets = [
    ['proto-sep', '__proto__', '2025-09-02'],
    ['constructor-sep', 'constructor', '2025-09-03'],
    ['total-sep', 'All created issues', '2025-09-04'],
    ['proto-oct', '__proto__', '2025-10-02'],
    ['string-oct', 'toString', '2025-10-03'],
  ].map(([id, type, date]) => ({ ...firstTicket, id, type,
    createdAt: `${date}T12:00:00Z`, status: 'unknown' as const, approvals: [] }));
  const report = aggregate({ ...withoutUsage(source), sourceKind: 'configured', endDate: '2025-12-31', tickets });
  const expected = [
    '{"__proto__":1,"constructor":1,"All created issues":1}',
    '{"__proto__":1,"toString":1}',
  ];
  for (const [index, counts] of expected.entries()) {
    const actual = report.monthly[index].issueTypes;
    assert.ok(actual);
    assert.equal(Object.getPrototypeOf(actual), null);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(counts));
    assert.equal(Object.getOwnPropertyDescriptor(actual, '__proto__')?.value, 1);
    assert.equal(Object.values(actual).reduce((sum, value) => sum + value, 0), index === 0 ? 3 : 2);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report.periods[0].issueTypes)),
    JSON.parse('{"__proto__":2,"constructor":1,"toString":1,"All created issues":1}'));
  assert.equal(Object.getPrototypeOf(report.periods[0].issueTypes), null);
  assert.equal(Object.getOwnPropertyDescriptor(report.periods[0].issueTypes ?? {}, '__proto__')?.value, 2);
  assert.equal(report.periods[0].issueTypes?.constructor, 1);
  assert.equal(report.periods[0].issueTypes?.toString, 1);
  assert.equal(Object.values(report.periods[0].issueTypes ?? {}).reduce((sum, value) => sum + value, 0), 5);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('incoming production bugs exclude nonproduction and qualify unknown imports', () => {
  const source = loadSynthetic();
  const bugs = [
    ticket('prod', { type: 'Bug', status: 'unknown', approvals: [], production: true,
      createdAt: '2026-03-11T00:00:00Z' }),
    ticket('nonprod', { type: 'Bug', status: 'unknown', approvals: [], production: false,
      createdAt: '2026-03-11T00:00:00Z' }),
    ticket('unspecified', { type: 'Bug', status: 'unknown', approvals: [],
      createdAt: '2026-03-11T00:00:00Z' }),
  ];
  const report = aggregate({ ...source, tickets: bugs });
  assert.equal(report.monthly[6].incomingBugs, 1);
  assert.equal(report.monthly[6].unknownProductionBugs, 1);
  assert.equal(report.monthly[6].measureStatus.incomingBugs, 'partial');
  assert.equal(report.periods[1].measureStatus.incomingBugs, 'partial');
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'incomingBugs' &&
    gap.reason.includes('production')));
  const syntheticReport = aggregate(source);
  assert.equal(syntheticReport.monthly[6].incomingBugs, 3);
  assert.equal(syntheticReport.monthly[6].measureStatus.incomingBugs, 'available');
});

test('eligible parents with unknown approval status count as missing, not open', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...source, tickets: [
    ticket('unknown-parent', { status: 'unknown', approvals: [], createdAt: '2026-03-01T00:00:00Z' }),
    ticket('open-parent', { status: 'open', approvals: [], createdAt: '2026-03-01T00:00:00Z' }),
    ticket('child', { parentId: 'unknown-parent', status: 'unknown', approvals: [],
      createdAt: '2026-03-01T00:00:00Z' }),
  ] });
  assert.equal(report.monthly[6].createdParents, 2);
  assert.equal(report.monthly[6].missingApproval, 1);
  assert.equal(report.monthly[6].openParents, 1);
});

test('merges and bots are excluded; test paths count once and links have separate buckets', () => {
  const source = loadSynthetic();
  const at = '2026-03-12T12:00:00Z';
  const commit = (hash: string, overrides: Partial<Commit>): Commit => ({
    hash, provenance: { source: 'test', recordId: hash }, parents: ['one'], at,
    paths: ['src/api.ts', 'tests/api.test.ts', 'tests/more.spec.ts'],
    bot: false, ticketIds: ['API-101'], ...overrides,
  });
  const report = aggregate({ ...source, commits: [
    commit('linked', {}), commit('unlinked', { ticketIds: [] }),
    commit('ambiguous', { ticketIds: ['API-101', 'API-102'] }),
    commit('merge', { parents: ['one', 'two'] }),
    commit('bot', { bot: true }),
    commit('source-only', { paths: ['src/contest.ts'], ticketIds: ['API-101'] }),
  ] });
  const march = report.monthly[6];
  assert.equal(march.commits, 4);
  assert.equal(march.testTouchCommits, 3);
  assert.deepEqual(march.commitLinks, { linked: 2, unlinked: 2, ambiguous: 1, excluded: 2 });
  assert.equal(report.exclusions.mergeCommits, 1);
  assert.equal(report.exclusions.botCommits, 1);
  assert.equal(report.exclusions.ambiguousCommitLinks, 1);
  assert.equal(report.exclusions.unlinkedCommitLinks, 2);
});

test('period test-touch share divides combined counts, not an average of monthly shares', () => {
  const source = loadSynthetic();
  const commits = source.commits;
  assert.ok(commits);
  const first = commits.filter(commit => commit.at.startsWith('2025-09')).slice(20, 21);
  const second = commits.filter(commit => commit.at.startsWith('2025-10'));
  const report = aggregate({ ...source, commits: [
    ...first, ...second.slice(0, 2), ...second.slice(20, 21),
  ] });
  assert.equal(report.monthly[0].testTouchShare, 0);
  assert.equal(report.monthly[1].testTouchShare, 2 / 3);
  assert.equal(report.periods[0].testTouchShare, 2 / 4);
});

test('mixed known and unknown ticket IDs do not assert an unambiguous commit link', () => {
  const source = loadSynthetic();
  const firstCommit = source.commits?.[0];
  assert.ok(firstCommit);
  const report = aggregate({ ...source, commits: [{ ...firstCommit, ticketIds: ['API-101', 'UNKNOWN'] }] });
  assert.equal(report.monthly[0].commitLinks?.linked, 0);
  assert.equal(report.monthly[0].commitLinks?.ambiguous, 1);
  assert.equal(report.monthly[0].commitLinks?.unlinked, 1);
});

test('complete observed commit diagnostics aggregate without exposing contributor identities', () => {
  const source = loadSynthetic();
  const first = source.commits?.[0];
  assert.ok(first);
  const commits: Commit[] = [
    { ...first, linesAdded: 12, linesDeleted: 4, contributorId: 'a@example.org', changeSize: 10 },
    { ...first, hash: 'second', linesAdded: 8, linesDeleted: 6,
      contributorId: 'b@example.org', changeSize: 30 },
    { ...first, hash: 'merge', parents: ['one', 'two'], linesAdded: 1000,
      linesDeleted: 1000, contributorId: 'excluded@example.org', changeSize: 2000 },
  ];
  const report = aggregate({ ...source, commits });
  assert.deepEqual(report.repositoryDiagnostics, {
    churn: { linesAdded: 20, linesDeleted: 10 }, contributorCount: 2, meanChangeSize: 20,
    medianChangeSize: 20, largeChangeShare: 0, testToSourceRatio: null,
  });
  assert.doesNotMatch(JSON.stringify(report), /@example\.org/);
});

test('eligible commit diagnostics include median, large multi-area share and test/source additions', () => {
  const source = loadSynthetic();
  const first = source.commits?.[0];
  assert.ok(first);
  const commits: Commit[] = [
    { ...first, hash: 'small', paths: ['src/a.ts'], linesAdded: 10, linesDeleted: 0,
      changeSize: 10, testLinesAdded: 0, sourceLinesAdded: 10, contributorId: 'private-a' },
    { ...first, hash: 'medium', paths: ['tests/a.test.ts', 'src/a.ts'], linesAdded: 30, linesDeleted: 0,
      changeSize: 30, testLinesAdded: 10, sourceLinesAdded: 20, contributorId: 'private-a' },
    { ...first, hash: 'large', paths: ['tests/b.test.ts', 'src/b.ts'], linesAdded: 10, linesDeleted: 140,
      changeSize: 150, testLinesAdded: 5, sourceLinesAdded: 5, contributorId: 'private-b' },
  ];
  const report = aggregate({ ...source, commits });
  const diagnostics = report.repositoryDiagnostics as typeof report.repositoryDiagnostics & {
    medianChangeSize?: number; largeChangeShare?: number; testToSourceRatio?: number;
  };
  assert.equal(report.repositoryDiagnostics?.contributorCount, 2);
  assert.equal(diagnostics?.medianChangeSize, 30);
  assert.equal(report.repositoryDiagnostics?.meanChangeSize, 190 / 3);
  assert.equal(diagnostics?.largeChangeShare, 1 / 3);
  assert.equal(diagnostics?.testToSourceRatio, 15 / 35);
  assert.doesNotMatch(JSON.stringify(report), /private-[ab]|src\/b\.ts/);
});

test('repository diagnostics definition reflects optional observation completeness', () => {
  const source = loadSynthetic();
  const first = source.commits?.[0];
  assert.ok(first);
  const definitionCoverage = (commits: Commit[]) => aggregate({ ...source, commits })
    .definitions.find(entry => entry.metric === 'repositoryDiagnostics')?.coverage;
  assert.equal(aggregate(source).definitions.find(entry =>
    entry.metric === 'repositoryDiagnostics')?.coverage, 'unavailable');
  const complete: Commit[] = [
    { ...first, linesAdded: 12, linesDeleted: 4, contributorId: 'person-1', changeSize: 10,
      testLinesAdded: 0, sourceLinesAdded: 12 },
    { ...first, hash: 'second', linesAdded: 8, linesDeleted: 6,
      contributorId: 'person-2', changeSize: 30, testLinesAdded: 0, sourceLinesAdded: 8 },
  ];
  assert.equal(definitionCoverage([complete[0], { ...first, hash: 'second', contributorId: 'person-2' }]),
    'partial');
  assert.equal(definitionCoverage(complete), 'available');
});

test('unsupported commit diagnostics stay null independently of observed fields', () => {
  const source = loadSynthetic();
  const first = source.commits?.[0];
  assert.ok(first);
  const report = aggregate({ ...source, commits: [
    { ...first, linesAdded: 12, linesDeleted: 4, contributorId: 'person-1', changeSize: 10 },
    { ...first, hash: 'second', contributorId: 'person-2' },
  ] });
  assert.deepEqual(report.repositoryDiagnostics, {
    churn: null, contributorCount: 2, meanChangeSize: null,
    medianChangeSize: null, largeChangeShare: null, testToSourceRatio: null,
  });
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'repositoryDiagnostics' &&
    gap.reason.includes('churn')));
  assert.equal(aggregate(source).repositoryDiagnostics, null);
});

test('unavailable sources and zero denominators do not become fabricated zero results', () => {
  const source = loadSynthetic();
  const tickets = source.tickets;
  assert.ok(tickets);
  const report = aggregate({ ...source,
    tickets: tickets.filter(ticket => ticket.createdAt >= '2026-03-01T00:00:00Z'),
    commits: [], usage: undefined, charges: undefined,
    coverage: source.coverage.map(entry =>
      entry.source === 'usage' || entry.source === 'charges'
        ? { ...entry, status: 'unavailable' as const, extracted: 0, linked: 0,
          reason: 'Not supplied.' } : entry),
  });
  assert.equal(report.periods[0].approvedParents, 0);
  assert.equal(report.comparisons.approvedParentsRelativeChange, null);
  assert.equal(report.periods[0].testTouchShare, null);
  assert.equal(report.monthly[0].tokens, null);
  assert.equal(report.monthly[0].toolSpend, null);
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'tokens'));
});

test('partial ticket and commit coverage qualifies zero monthly and period results', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...source, tickets: [], commits: [],
    coverage: source.coverage.map(entry => entry.source === 'tickets' || entry.source === 'commits'
      ? { ...entry, status: 'partial' as const, reason: 'Import incomplete.' } : entry),
  });
  assert.equal(report.monthly[0].approvedParents, 0);
  assert.equal(report.monthly[0].commits, 0);
  assert.equal(report.monthly[0].measureStatus.approvedParents, 'partial');
  assert.equal(report.monthly[0].measureStatus.incomingBugs, 'partial');
  assert.equal(report.monthly[0].measureStatus.commits, 'partial');
  assert.equal(report.monthly[0].measureStatus.testTouchShare, 'partial');
  assert.equal(report.periods[0].measureStatus.approvedParents, 'partial');
  assert.equal(report.periods[0].measureStatus.commits, 'partial');
});

test('empty billing and usage exports cannot be reported as complete zero by the operational report', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...source, usage: [], charges: [] });
  assert.equal(report.monthly[0].measureStatus.tokens, 'partial');
  assert.equal(report.monthly[0].measureStatus.toolSpend, 'partial');
  assert.equal(report.periods[0].measureStatus.tokens, 'partial');
  assert.equal(report.periods[0].measureStatus.toolSpend, 'partial');
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'tokens' && /no records/i.test(gap.reason)));
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'toolSpend' && /no records/i.test(gap.reason)));
});

test('comparisons do not imply complete changes from partial monthly inputs', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...source,
    coverage: source.coverage.map(entry => entry.source === 'tickets' || entry.source === 'commits'
      ? { ...entry, status: 'partial' as const, reason: 'Import incomplete.' } : entry),
  });
  assert.equal(report.monthly[0].approvedParents, 18);
  assert.equal(report.comparisons.approvedParentsRelativeChange, null);
  assert.equal(report.comparisons.incomingBugsRelativeChange, null);
  assert.equal(report.comparisons.commitsRelativeChange, null);
  assert.equal(report.comparisons.testTouchSharePercentagePoints, null);
});

test('lead time requires start evidence for every approved parent', () => {
  const source = loadSynthetic();
  const withStart = ticket('with-start', { startedAt: '2026-02-20T00:00:00Z' });
  const withoutStart = ticket('without-start', {});
  const incomplete = aggregate({ ...source, tickets: [withStart, withoutStart] });
  assert.equal(incomplete.leadTime, null);
  assert.equal(incomplete.monthly[6].missingStartTimes, 1);

  const complete = aggregate({ ...source,
    tickets: [withStart, { ...withoutStart, startedAt: '2026-02-28T00:00:00Z' }],
    coverage: source.coverage.map(entry => entry.source === 'start-times'
      ? { ...entry, status: 'available' as const, eligible: 2, extracted: 2,
          linked: 2, missing: 0, reason: '' } : entry),
  });
  assert.equal(complete.leadTime, 6);
  assert.equal(complete.monthly[6].missingStartTimes, 0);
  assert.equal(complete.evidenceGaps.some(gap => gap.metric === 'leadTime'), false);
});

test('lead time uses first approval in the reporting window, consistent with approval ordering', () => {
  const source = loadSynthetic();
  const inWindow = ticket('in-window', { startedAt: '2026-02-28T00:00:00Z', approvals: [
    { at: '2026-03-02T00:00:00Z', releaseId: 'first' },
    { at: '2026-03-22T00:00:00Z', releaseId: 'second' },
  ] });
  const outside = ticket('outside', { createdAt: '2026-09-01T00:00:00Z',
    approvals: [{ at: '2026-09-20T00:00:00Z', releaseId: 'later' }] });
  const report = aggregate({ ...source, tickets: [inWindow, outside],
    coverage: source.coverage.map(entry => entry.source === 'start-times'
      ? { ...entry, status: 'available' as const, eligible: 1, extracted: 1,
          linked: 1, missing: 0, reason: '' } : entry),
  });
  assert.equal(report.leadTime, 2);
  assert.equal(report.evidenceGaps.some(gap => gap.metric === 'leadTime'), false);
  assert.throws(() => validateBundle({ ...source, tickets: [{ ...inWindow,
    approvals: [...inWindow.approvals].reverse(),
  }] }), /approvals must follow work events in order/);
});

test('lead time is unknown when ticket coverage is partial despite observed starts', () => {
  const source = loadSynthetic();
  const report = aggregate({ ...source,
    tickets: [ticket('observed', { startedAt: '2026-02-28T00:00:00Z' })],
    coverage: source.coverage.map(entry => entry.source === 'tickets'
      ? { ...entry, status: 'partial' as const, reason: 'Some tickets were not imported.' }
      : entry.source === 'start-times'
        ? { ...entry, status: 'available' as const, eligible: 1, extracted: 1,
            linked: 1, missing: 0, reason: '' } : entry),
  });
  assert.equal(report.leadTime, null);
  assert.ok(report.evidenceGaps.some(gap => gap.metric === 'leadTime' &&
    gap.reason.includes('ticket')));
});