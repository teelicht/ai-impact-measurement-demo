import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Charge, Commit, Coverage, MonthlyUsage, SourceBundle, Ticket } from '../model.js';
import { validateBundle } from '../validate.js';

interface MonthlyRow {
  month: string;
  approved: number;
  commits: number;
  testTouches: number;
  bugs: number;
  tokensMillions: number;
  toolSpendEur: number;
}

interface MonthlyFixture {
  version: number;
  metadata: { firstMonth: string; lastMonth: string; mappingNote: string };
  rows: MonthlyRow[];
}

function provenance(source: string, recordId: string) {
  return { source, recordId };
}

export function loadSynthetic(): SourceBundle {
  const fixture = JSON.parse(readFileSync(
    new URL('../../../data/api-team-monthly.json', import.meta.url), 'utf8',
  )) as MonthlyFixture;
  if (fixture.version !== 1 || fixture.rows.length !== 12) {
    throw new Error('synthetic fixture: expected version 1 with twelve months');
  }

  const tickets: Ticket[] = [];
  const commits: Commit[] = [];
  const usage: MonthlyUsage[] = [];
  const charges: Charge[] = [];
  let nextTicket = 1000;
  let previousHash: string | undefined;

  fixture.rows.forEach((row, monthIndex) => {
    const month = new Date(Date.UTC(2025, 8 + monthIndex, 1)).toISOString().slice(0, 7);
    const parentIds: string[] = [];
    if (row.month === 'M7') {
      for (const [id, type] of [['API-101', 'Story'], ['API-102', 'Task']] as const) {
        tickets.push({
          id, type, status: 'approved', provenance: provenance('synthetic-tickets', id),
          createdAt: `${month}-02T09:00:00Z`,
          approvals: [{ at: `${month}-20T10:00:00Z`, releaseId: `${row.month}-release` },
            ...(id === 'API-102' ? [{ at: `${month}-25T10:00:00Z`, releaseId: `${row.month}-second-release` }] : [])],
        });
        parentIds.push(id);
      }
      tickets.push({
        id: 'API-103', type: 'Sub-task', status: 'unknown', parentId: 'API-101',
        provenance: provenance('synthetic-tickets', 'API-103'),
        createdAt: `${month}-03T09:00:00Z`, approvals: [],
      });
      tickets.push({
        id: 'API-104', type: 'Story', status: 'open', provenance: provenance('synthetic-tickets', 'API-104'),
        createdAt: `${month}-04T09:00:00Z`, approvals: [],
      });
    }

    for (let parentIndex = parentIds.length; parentIndex < row.approved; parentIndex++) {
      const id = `API-${nextTicket++}`;
      tickets.push({
        id, type: parentIndex % 2 === 0 ? 'Story' : 'Task', status: 'approved',
        provenance: provenance('synthetic-tickets', id),
        createdAt: `${month}-02T09:00:00Z`,
        approvals: [{ at: `${month}-20T10:00:00Z`, releaseId: `${row.month}-release` }],
      });
      parentIds.push(id);
    }

    for (let bugIndex = 0; bugIndex < row.bugs; bugIndex++) {
      const id = `API-BUG-${row.month}-${bugIndex + 1}`;
      tickets.push({
        id, type: 'Bug', status: 'unknown', production: true,
        provenance: provenance('synthetic-tickets', id),
        createdAt: `${month}-11T09:00:00Z`, approvals: [],
      });
    }

    for (let commitIndex = 0; commitIndex < row.commits; commitIndex++) {
      const hash = createHash('sha256').update(`${row.month}:${commitIndex}`).digest('hex');
      const touchesTests = commitIndex < row.testTouches;
      commits.push({
        hash, provenance: provenance('synthetic-commits', hash),
        parents: previousHash ? [previousHash] : [],
        at: new Date(Date.UTC(2025, 8 + monthIndex, 12, 0, commitIndex)).toISOString(),
        paths: touchesTests
          ? ['src/api.ts', 'tests/api.test.ts', ...(commitIndex === 0 ? ['tests/contract.test.ts'] : [])]
          : ['src/api.ts'],
        bot: false, ticketIds: [row.month === 'M7' && commitIndex === 0
          ? 'API-103' : parentIds[commitIndex % parentIds.length]],
      });
      previousHash = hash;
    }

    const usageId = `usage-${row.month}-total`;
    usage.push({
      kind: 'monthly-total', id: usageId, provenance: provenance('synthetic-monthly-usage', usageId),
      month, tokens: row.tokensMillions * 1_000_000,
    });

    const subscription = Math.floor(row.toolSpendEur / 4);
    for (const [category, amount] of [
      ['subscription', subscription], ['consumption', row.toolSpendEur - subscription],
    ] as const) {
      const id = `charge-${row.month}-${category}`;
      charges.push({
        id, provenance: provenance('synthetic-billing', id), month, currency: 'EUR',
        billId: `bill-${row.month}-${category}`, billTotal: amount, allocatedTo: 'Fictional API team',
        category, amount, allocationKey: `api-team-${category}`,
      });
    }
  });

  const approvedCount = fixture.rows.reduce((total, row) => total + row.approved, 0);
  const bugCount = fixture.rows.reduce((total, row) => total + row.bugs, 0);
  const available = (source: string, extracted: number): Coverage => ({
    source, status: 'available', eligible: extracted, extracted,
    linked: extracted, excluded: 0, missing: 0, reason: '',
  });
  const unavailable = (source: string, eligible: number, reason: string): Coverage => ({
    source, status: 'unavailable', eligible, extracted: 0,
    linked: 0, excluded: 0, missing: eligible, reason,
  });
  const bundle: SourceBundle = {
    scope: 'Fictional API team', sourceKind: 'synthetic',
    context: {
      owner: 'Engineering lead (fictional)', updatedAt: '2026-09-01',
      description: 'Fictional API team maintaining backward-compatible endpoint changes.',
      includedWork: 'Eligible Stories and Tasks at first release approval; eligible non-merge commits and incoming production bugs.',
      excludedWork: 'Emergency fixes, larger contract changes, defects and sub-tasks are excluded from approved Stories and Tasks.',
      aiUse: 'Agents prepare endpoint changes. Use becomes more systematic in M7; earlier AI use is not excluded. AI exposure per change is unknown.',
      concurrentChanges: 'Staffing, process and tool/model version changes were not recorded for these windows.',
      question: 'What changed in delivery, quality, workload and spending between M1-M6 and M7-M12?',
      controls: 'Guardrail status and review capacity are not assessed from these records.',
      resourceLimits: 'Historical affordability limit and total AI cost were not recorded.',
      repositories: ['Synthetic API commit history'],
    },
    startDate: `${fixture.metadata.firstMonth}-01`,
    endDate: new Date(Date.UTC(2025, 8 + fixture.rows.length, 0)).toISOString().slice(0, 10),
    timezone: 'UTC', extractedAt: '2026-09-01T00:00:00Z', currency: 'EUR',
    completenessAttestation: 'Version 1 synthetic monthly targets; ' + fixture.metadata.mappingNote +
      ' The source declares input-plus-output totals including cached input, failed attempts and retries; components and work-item links cannot be verified from monthly records. Historical effort, start times and defect-release linkage are unavailable.',
    coverage: [
      { source: 'tickets', status: 'available', eligible: approvedCount + 1,
        extracted: tickets.length, linked: approvedCount, excluded: bugCount + 1,
        missing: 0, reason: 'One eligible Story is still open; bugs and the child are excluded from approved output.' },
      available('commits', commits.length),
      { ...available('usage', usage.length), linked: 0,
        reason: 'Monthly token totals are available; model, token categories, attempts and work-item links are unavailable.' },
      available('charges', charges.length),
      unavailable('historical-effort', approvedCount, 'No observed human effort records.'),
      unavailable('start-times', approvedCount, 'No historical start events; do not infer lead time.'),
      unavailable('defect-release-linkage', bugCount, 'Incoming bugs have no release association.'),
    ],
    tickets, commits, usage, charges,
  };
  return validateBundle(bundle);
}