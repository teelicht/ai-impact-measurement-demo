import type { Commit, Coverage, SourceBundle, Ticket } from './model.js';
import { summarizeUsageAndCost, type UsageCostMonth } from './finance.js';
import { classifyCommitLink, isUnitTestPath } from './commit-links.js';

interface CommitLinks {
  linked: number;
  unlinked: number;
  ambiguous: number;
  excluded: number;
}

type MeasureStatus = Record<'approvedParents' | 'createdParents' | 'openParents' |
  'missingApproval' | 'missingStartTimes' | 'incomingBugs' | 'unknownProductionBugs' | 'issueTypes' |
  'commits' | 'testTouchCommits' | 'testTouchShare' | 'commitLinks' |
  'tokens' | 'toolSpend', Coverage['status']>;

export interface OperationalCounts {
  measureStatus: MeasureStatus;
  approvedParents: number | null;
  createdParents: number | null;
  openParents: number | null;
  missingApproval: number | null;
  missingStartTimes: number | null;
  incomingBugs: number | null;
  unknownProductionBugs: number | null;
  commits: number | null;
  testTouchCommits: number | null;
  testTouchShare: number | null;
  tokens: number | null;
  toolSpend: number | null;
  issueTypes: Record<string, number> | null;
  commitLinks: CommitLinks | null;
}

export interface OperationalMonth extends OperationalCounts {
  label: string;
  month: string;
  usage: Pick<UsageCostMonth, 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'byModel' |
    'attempts' | 'workItemLinks'> | null;
  billingCategories: Record<string, number> | null;
  toolSpendPerApprovedParent: number | null;
}

export interface OperationalPeriod extends OperationalCounts {
  label: string;
  startMonth: string;
  endMonth: string;
}

export interface OperationalReport {
  scope: string;
  sourceKind: SourceBundle['sourceKind'];
  startDate: string;
  endDate: string;
  completenessAttestation: string;
  timezone: string;
  currency: string;
  extractedAt: string;
  monthly: OperationalMonth[];
  periods: OperationalPeriod[];
  comparisons: {
    approvedParentsRelativeChange: number | null;
    commitsRelativeChange: number | null;
    incomingBugsRelativeChange: number | null;
    testTouchSharePercentagePoints: number | null;
  };
  coverage: Coverage[];
  definitions: { metric: string; definition: string; source: string; coverage: Coverage['status'] }[];
  exclusions: {
    children: number;
    emergency: number;
    nonEligibleTypes: number;
    duplicateApprovals: number;
    mergeCommits: number;
    botCommits: number;
    ambiguousCommitLinks: number;
    unlinkedCommitLinks: number;
    bugsWithUnknownReleaseLinkage: number;
  };
  evidenceGaps: { metric: string; reason: string }[];
  leadTime: number | null;
  humanEffort: number | null;
  escapedDefects: number | null;
  totalAiCost: null;
  roi: null;
  releaseDiagnostics: null;
  repositoryDiagnostics: {
    churn: { linesAdded: number; linesDeleted: number } | null;
    contributorCount: number | null;
    meanChangeSize: number | null;
    medianChangeSize: number | null;
    largeChangeShare: number | null;
    testToSourceRatio: number | null;
  } | null;
}

function dateInTimezone(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error(`Cannot format date in timezone ${timezone}`);
  return `${year}-${month}-${day}`;
}

function monthInTimezone(timestamp: string, timezone: string): string {
  return dateInTimezone(timestamp, timezone).slice(0, 7);
}

function firstApproval(ticket: Ticket): string | undefined {
  return ticket.approvals.reduce<string | undefined>((earliest, approval) =>
    earliest === undefined || Date.parse(approval.at) < Date.parse(earliest) ? approval.at : earliest,
  undefined);
}

export function countApprovedParents(tickets: Ticket[], timezone: string): Map<string, number> {
  const monthly = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.parentId || ticket.emergency ||
        !['Story', 'Task'].includes(ticket.type) || ticket.status !== 'approved') continue;
    const first = firstApproval(ticket);
    if (first === undefined) continue;
    const month = monthInTimezone(first, timezone);
    monthly.set(month, (monthly.get(month) ?? 0) + 1);
  }
  return monthly;
}

function eligibleParent(ticket: Ticket): boolean {
  return !ticket.parentId && !ticket.emergency && (ticket.type === 'Story' || ticket.type === 'Task');
}

function addNullable(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : before + after;
}

function leastComplete(first: Coverage['status'], second: Coverage['status']): Coverage['status'] {
  if (first === 'unavailable' || second === 'unavailable') return 'unavailable';
  if (first === 'partial' || second === 'partial') return 'partial';
  return 'available';
}

function combine(rows: OperationalMonth[], label: string, sourceStatus: MeasureStatus): OperationalPeriod {
  const measureStatus = { ...sourceStatus };
  for (const row of rows) {
    for (const key of Object.keys(measureStatus) as (keyof MeasureStatus)[]) {
      measureStatus[key] = leastComplete(measureStatus[key], row.measureStatus[key]);
    }
  }
  const total = (field: 'approvedParents' | 'createdParents' | 'openParents' | 'missingApproval' | 'missingStartTimes' |
    'incomingBugs' | 'unknownProductionBugs' | 'commits' | 'testTouchCommits' | 'tokens' | 'toolSpend') =>
    rows.reduce<number | null>((sum, row) => {
      const value = addNullable(sum, row[field]);
      if (field === 'tokens' && value !== null && !Number.isSafeInteger(value)) {
        throw new Error('tokens: period total exceeds safe integer precision');
      }
      return value;
    }, 0);
  const commits = total('commits');
  const testTouchCommits = total('testTouchCommits');
  const issueTypes = rows.every(row => row.issueTypes !== null)
    ? rows.reduce<Record<string, number>>((counts, row) => {
      for (const [type, count] of Object.entries(row.issueTypes ?? {})) {
        counts[type] = (counts[type] ?? 0) + count;
      }
      return counts;
    }, Object.create(null) as Record<string, number>) : null;
  const commitLinks = rows.every(row => row.commitLinks !== null)
    ? rows.reduce<CommitLinks>((counts, row) => {
      for (const key of ['linked', 'unlinked', 'ambiguous', 'excluded'] as const) {
        counts[key] += row.commitLinks?.[key] ?? 0;
      }
      return counts;
    }, { linked: 0, unlinked: 0, ambiguous: 0, excluded: 0 }) : null;
  return {
    label, startMonth: rows[0]?.month ?? '', endMonth: rows.at(-1)?.month ?? '', measureStatus,
    approvedParents: total('approvedParents'), createdParents: total('createdParents'),
    openParents: total('openParents'), missingApproval: total('missingApproval'),
    missingStartTimes: total('missingStartTimes'),
    incomingBugs: total('incomingBugs'), unknownProductionBugs: total('unknownProductionBugs'),
    commits, testTouchCommits,
    testTouchShare: commits === null || testTouchCommits === null || commits === 0
      ? null : testTouchCommits / commits,
    tokens: total('tokens'), toolSpend: total('toolSpend'), issueTypes, commitLinks,
  };
}

function relativeChange(before: number | null, after: number | null,
  beforeMonths: number, afterMonths: number): number | null {
  return before === null || after === null || before === 0 ? null :
    (after * beforeMonths) / (before * afterMonths) - 1;
}

export function aggregate(bundle: SourceBundle): OperationalReport {
  const coverage = bundle.coverage;
  const accounting = summarizeUsageAndCost(bundle);
  const status = (source: string) => coverage.find(entry => entry.source === source)?.status ?? 'unavailable';
  const sourceStatus: MeasureStatus = {
    approvedParents: status('tickets'), createdParents: status('tickets'),
    openParents: status('tickets'), missingApproval: status('tickets'),
    missingStartTimes: status('tickets'), incomingBugs: status('tickets'),
    unknownProductionBugs: status('tickets'),
    issueTypes: status('tickets'), commits: status('commits'),
    testTouchCommits: status('commits'), testTouchShare: status('commits'),
    commitLinks: leastComplete(status('tickets'), status('commits')),
    tokens: accounting.monthly[0]?.measureStatus.tokens ?? status('usage'),
    toolSpend: accounting.monthly[0]?.measureStatus.toolSpend ?? status('charges'),
  };
  const months: string[] = [];
  let year = Number(bundle.startDate.slice(0, 4));
  let month = Number(bundle.startDate.slice(5, 7));
  const lastMonth = bundle.endDate.slice(0, 7);
  while (`${year}-${String(month).padStart(2, '0')}` <= lastMonth) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month++;
    if (month === 13) { year++; month = 1; }
  }

  const approved = countApprovedParents(bundle.tickets ?? [], bundle.timezone);
  const missingStartsByMonth = countApprovedParents(
    (bundle.tickets ?? []).filter(ticket => !ticket.startedAt), bundle.timezone);
  const knownTickets = new Set((bundle.tickets ?? []).map(ticket => ticket.id));
  const monthly: OperationalMonth[] = months.map((window, index) => {
    const financeMonth = accounting.monthly[index];
    const created = bundle.tickets?.filter(ticket =>
      monthInTimezone(ticket.createdAt, bundle.timezone) === window);
    const parents = created?.filter(eligibleParent);
    const issues = created === undefined ? null : created.reduce<Record<string, number>>((counts, ticket) => {
      counts[ticket.type] = (counts[ticket.type] ?? 0) + 1;
      return counts;
    }, Object.create(null) as Record<string, number>);
    const relevantCommits = bundle.commits?.filter(commit =>
      monthInTimezone(commit.at, bundle.timezone) === window);
    const excluded = relevantCommits?.filter(commit => commit.bot || commit.parents.length > 1);
    const included = relevantCommits?.filter(commit => !commit.bot && commit.parents.length <= 1);
    const testTouchCommits = included?.filter(commit => commit.paths.some(isUnitTestPath)).length ?? null;
    const commits = included?.length ?? null;
    const commitLinks = included === undefined ? null : included.reduce<CommitLinks>((counts, commit) => {
      const link = classifyCommitLink(commit, knownTickets);
      counts[link]++;
      if (link === 'ambiguous') counts.unlinked++;
      return counts;
    }, { linked: 0, unlinked: 0, ambiguous: 0, excluded: excluded?.length ?? 0 });
    const unknownProductionBugs = created?.filter(ticket => ticket.type === 'Bug' &&
      ticket.production === undefined).length ?? null;
    return {
      label: `M${index + 1}`, month: window,
      measureStatus: { ...sourceStatus, incomingBugs: unknownProductionBugs && sourceStatus.incomingBugs === 'available'
        ? 'partial' : sourceStatus.incomingBugs },
      approvedParents: created === undefined ? null : approved.get(window) ?? 0,
      createdParents: parents?.length ?? null,
      openParents: parents?.filter(ticket => ticket.status === 'open').length ?? null,
      missingApproval: parents?.filter(ticket => ticket.status === 'unknown').length ?? null,
      missingStartTimes: created === undefined ? null : missingStartsByMonth.get(window) ?? 0,
      incomingBugs: created?.filter(ticket => ticket.type === 'Bug' && ticket.production === true).length ?? null,
      unknownProductionBugs,
      issueTypes: issues, commits, testTouchCommits,
      testTouchShare: commits === null || testTouchCommits === null || commits === 0
        ? null : testTouchCommits / commits,
      commitLinks,
      tokens: financeMonth.tokens, toolSpend: financeMonth.toolSpend,
      usage: bundle.usage === undefined ? null : {
        inputTokens: financeMonth.inputTokens, cachedInputTokens: financeMonth.cachedInputTokens,
        outputTokens: financeMonth.outputTokens, byModel: financeMonth.byModel,
        attempts: financeMonth.attempts, workItemLinks: financeMonth.workItemLinks,
      },
      billingCategories: financeMonth.billingCategories,
      toolSpendPerApprovedParent: financeMonth.toolSpendPerApprovedParent,
    };
  });
  const splitIndex = Math.floor(monthly.length / 2);
  const periods = monthly.length < 2 ? [] : [
    combine(monthly.slice(0, splitIndex), `M1-M${splitIndex}`, sourceStatus),
    combine(monthly.slice(splitIndex), `M${splitIndex + 1}-M${monthly.length}`, sourceStatus),
  ];
  const [before, after] = periods;
  const tickets = bundle.tickets ?? [];
  const commits = bundle.commits ?? [];
  const includedCommits = commits.filter(commit => !commit.bot && commit.parents.length <= 1 &&
    months.includes(monthInTimezone(commit.at, bundle.timezone)));
  const completeCommits = status('commits') === 'available' && includedCommits.length > 0;
  const sizedCommits = includedCommits.filter((commit): commit is Commit & { changeSize: number } =>
    commit.changeSize !== undefined);
  const sizes = completeCommits && sizedCommits.length === includedCommits.length
    ? sizedCommits.map(commit => commit.changeSize).sort((left, right) => left - right) : null;
  const addedCommits = includedCommits.filter((commit): commit is Commit & {
    sourceLinesAdded: number; testLinesAdded: number;
  } => commit.sourceLinesAdded !== undefined && commit.testLinesAdded !== undefined);
  const sourceLines = completeCommits && addedCommits.length === includedCommits.length
    ? addedCommits.reduce((sum, commit) => sum + commit.sourceLinesAdded, 0) : null;
  const diagnostics = {
    churn: completeCommits && includedCommits.every(commit =>
      commit.linesAdded !== undefined && commit.linesDeleted !== undefined)
      ? includedCommits.reduce((totals, commit) => ({
        linesAdded: totals.linesAdded + (commit.linesAdded ?? 0),
        linesDeleted: totals.linesDeleted + (commit.linesDeleted ?? 0),
      }), { linesAdded: 0, linesDeleted: 0 }) : null,
    contributorCount: completeCommits && includedCommits.every(commit => commit.contributorId !== undefined)
      ? new Set(includedCommits.map(commit => commit.contributorId)).size : null,
    meanChangeSize: sizes === null ? null : sizes.reduce((sum, size) => sum + size, 0) / sizes.length,
    medianChangeSize: sizes === null ? null : sizes.length % 2 === 0
      ? (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2 : sizes[Math.floor(sizes.length / 2)],
    largeChangeShare: sizes === null ? null : sizedCommits.filter(commit =>
      commit.changeSize > 100 && new Set(commit.paths.map(path =>
        path.includes('/') ? path.split('/')[0] : path.split('.').at(-1))).size >= 2).length / sizedCommits.length,
    testToSourceRatio: sourceLines === null || sourceLines === 0 ? null :
      addedCommits.reduce((sum, commit) => sum + commit.testLinesAdded, 0) / sourceLines,
  };
  const repositoryDiagnostics = diagnostics.churn === null && diagnostics.contributorCount === null &&
    diagnostics.meanChangeSize === null && diagnostics.medianChangeSize === null &&
    diagnostics.largeChangeShare === null && diagnostics.testToSourceRatio === null ? null : diagnostics;
  const diagnosticCoverage: Coverage['status'] = repositoryDiagnostics === null ? 'unavailable'
    : Object.values(diagnostics).some(value => value === null)
      ? 'partial' : 'available';
  const definitions = [
    { metric: 'approvedParents', definition: 'Eligible parent Story or Task at first release approval; no children, defects or emergency fixes.', source: 'tickets' },
    { metric: 'createdParents', definition: 'Eligible parent Stories and Tasks grouped by creation month, whether approved or open.', source: 'tickets' },
    { metric: 'incomingBugs', definition: 'Confirmed production Bug tickets grouped by creation month; unknown environments are excluded and reported separately.', source: 'tickets' },
    { metric: 'commits', definition: 'Distinct non-merge, non-bot commits by month.', source: 'commits' },
    { metric: 'testTouchShare', definition: 'Eligible commits touching a tests/ or __tests__/ path, a .test/.spec JS/TS file, a _test.go file or a test_*.py file, once per commit, divided by all eligible commits.', source: 'commits' },
    { metric: 'tokens', definition: 'Input plus output tokens across all attempts; cached input is already part of input.', source: 'usage' },
    { metric: 'toolSpend', definition: 'Sum of recorded tool charges in report currency, not total AI cost.', source: 'charges' },
    { metric: 'toolSpendPerApprovedParent', definition: 'Recorded consumption, allocated subscriptions and other tool charges divided by approved parents when billing and ticket coverage are complete.', source: 'charges' },
    { metric: 'totalAiCost', definition: 'Tool charges plus human review, correction, enablement, governance and platform costs; unavailable for the API team.', source: 'total-ai-cost' },
    { metric: 'roi', definition: 'Net benefit divided by complete total AI cost over the same period; unassessed for the API team.', source: 'total-ai-cost' },
    { metric: 'leadTime', definition: 'Mean calendar days from observed start to first release approval, only with complete start events.', source: 'start-times' },
    { metric: 'humanEffort', definition: 'Observed non-overlapping person-minutes by activity, never inferred from elapsed time.', source: 'historical-effort' },
    { metric: 'escapedDefects', definition: 'Bugs linked to an approved release with follow-up coverage, not all incoming bugs.', source: 'defect-release-linkage' },
    { metric: 'repositoryDiagnostics', definition: 'Observed line churn, distinct contributors, median and mean change size, share above 100 changed lines across two areas, and unit-test/source lines added ratio for eligible commits; no contributor identities reported. No move discount or effort inference.', source: 'commits' },
  ].map(entry => ({ ...entry, coverage: entry.metric === 'repositoryDiagnostics'
    ? leastComplete(status('commits'), diagnosticCoverage)
    : entry.metric === 'incomingBugs' && monthly.some(row => row.measureStatus.incomingBugs === 'partial')
      ? 'partial' as const : entry.metric === 'tokens' || entry.metric === 'toolSpend'
        ? sourceStatus[entry.metric] : status(entry.source) }));
  const eligible = tickets.filter(eligibleParent);
  const approvedTickets = eligible.flatMap(ticket => {
    if (ticket.status !== 'approved') return [];
    const first = firstApproval(ticket);
    if (!first || dateInTimezone(first, bundle.timezone) < bundle.startDate ||
        dateInTimezone(first, bundle.timezone) > bundle.endDate) return [];
    return [{ ticket, first }];
  });
  const missingStarts = approvedTickets.filter(({ ticket }) => !ticket.startedAt).length;
  const leadTime = approvedTickets.length > 0 && missingStarts === 0 &&
    status('tickets') === 'available' && status('start-times') === 'available'
    ? approvedTickets.reduce((sum, { ticket, first }) => {
        if (ticket.startedAt === undefined) throw new Error(`Missing start event for ${ticket.id}`);
        return sum + (Date.parse(first) - Date.parse(ticket.startedAt)) / 86_400_000;
      }, 0)
      / approvedTickets.length : null;
  const evidenceGaps: OperationalReport['evidenceGaps'] = [];
  for (const [metric, source] of [
    ['approvedParents', 'tickets'], ['commits', 'commits'], ['tokens', 'usage'],
    ['toolSpend', 'charges'],
  ] as const) {
    const entry = coverage.find(item => item.source === source);
    const accountingGap = accounting.evidenceGaps.find(gap => gap.metric === source);
    if (accountingGap || entry?.status !== 'available') {
      evidenceGaps.push({ metric, reason: accountingGap?.reason || entry?.reason || `${source} source not supplied.` });
    }
  }
  const unknownProductionBugs = monthly.reduce((sum, row) => sum + (row.unknownProductionBugs ?? 0), 0);
  if (unknownProductionBugs > 0) {
    evidenceGaps.push({ metric: 'incomingBugs', reason:
      `${unknownProductionBugs} Bug tickets have unknown production environment.` });
  }
  if (leadTime === null) {
    evidenceGaps.push({ metric: 'leadTime', reason: status('tickets') !== 'available'
      ? 'Complete ticket coverage is required for lead time.'
      : status('start-times') !== 'available'
        ? coverage.find(entry => entry.source === 'start-times')?.reason || 'Start-time coverage unavailable.'
        : `Start times missing for ${missingStarts} approved parents; ${approvedTickets.length} approved parents in scope.` });
  }
  evidenceGaps.push({ metric: 'humanEffort', reason: coverage.find(entry => entry.source === 'historical-effort')?.reason ||
    'Observed non-overlapping person-minutes by activity are not available.' });
  evidenceGaps.push({ metric: 'escapedDefects', reason: coverage.find(entry => entry.source === 'defect-release-linkage')?.reason ||
    'Bug-to-release links and follow-up coverage are not available.' });
  evidenceGaps.push({ metric: 'totalAiCost', reason: accounting.financialGaps[0] });
  evidenceGaps.push({ metric: 'roi', reason: accounting.financialGaps[0] });
  const missingDiagnostics = [
    diagnostics.churn === null ? 'churn' : null,
    diagnostics.contributorCount === null ? 'contributor' : null,
    diagnostics.meanChangeSize === null ? 'change-size' : null,
    diagnostics.testToSourceRatio === null ? 'test/source additions' : null,
  ].filter(item => item !== null);
  if (missingDiagnostics.length > 0) {
    evidenceGaps.push({ metric: 'repositoryDiagnostics', reason:
      `Complete eligible-commit observations unavailable for ${missingDiagnostics.join(', ')} diagnostics.` });
  }
  evidenceGaps.push({ metric: 'releaseDiagnostics', reason:
    'Approval links provide release IDs but no release history or completion events.' });

  return {
    scope: bundle.scope, sourceKind: bundle.sourceKind,
    startDate: bundle.startDate, endDate: bundle.endDate,
    completenessAttestation: bundle.completenessAttestation, timezone: bundle.timezone,
    currency: bundle.currency, extractedAt: bundle.extractedAt, monthly, periods,
    comparisons: {
      approvedParentsRelativeChange: before && after && before.measureStatus.approvedParents === 'available' &&
        after.measureStatus.approvedParents === 'available'
        ? relativeChange(before.approvedParents, after.approvedParents, splitIndex, monthly.length - splitIndex) : null,
      commitsRelativeChange: before && after && before.measureStatus.commits === 'available' &&
        after.measureStatus.commits === 'available'
        ? relativeChange(before.commits, after.commits, splitIndex, monthly.length - splitIndex) : null,
      incomingBugsRelativeChange: before && after && before.measureStatus.incomingBugs === 'available' &&
        after.measureStatus.incomingBugs === 'available'
        ? relativeChange(before.incomingBugs, after.incomingBugs, splitIndex, monthly.length - splitIndex) : null,
      testTouchSharePercentagePoints: !before || !after || before.measureStatus.testTouchShare !== 'available' ||
        after.measureStatus.testTouchShare !== 'available' ||
        before.testTouchShare === null || after.testTouchShare === null
        ? null : (after.testTouchShare - before.testTouchShare) * 100,
    },
    coverage, definitions,
    exclusions: {
      children: tickets.filter(ticket => ticket.parentId).length,
      emergency: tickets.filter(ticket => !ticket.parentId && ticket.emergency).length,
      nonEligibleTypes: tickets.filter(ticket => !ticket.parentId && !ticket.emergency &&
        !eligibleParent(ticket)).length,
      duplicateApprovals: eligible.reduce((sum, ticket) => sum + Math.max(0, ticket.approvals.length - 1), 0),
      mergeCommits: commits.filter(commit => commit.parents.length > 1).length,
      botCommits: commits.filter(commit => commit.bot && commit.parents.length <= 1).length,
      ambiguousCommitLinks: monthly.reduce((sum, row) => sum + (row.commitLinks?.ambiguous ?? 0), 0),
      unlinkedCommitLinks: monthly.reduce((sum, row) => sum + (row.commitLinks?.unlinked ?? 0), 0),
      bugsWithUnknownReleaseLinkage: tickets.filter(ticket => ticket.type === 'Bug').length,
    },
    evidenceGaps, leadTime, humanEffort: null, escapedDefects: null,
    totalAiCost: accounting.totalAiCost, roi: accounting.roi,
    releaseDiagnostics: null, repositoryDiagnostics,
  };
}