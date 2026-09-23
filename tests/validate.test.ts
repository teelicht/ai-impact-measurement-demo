import assert from 'node:assert/strict';
import test from 'node:test';
import type { MonthlyUsage, SourceBundle, Ticket, UsageEvent } from '../src/model.js';
import { validateBundle } from '../src/validate.js';

const usage: UsageEvent = {
  id: 'usage-1', at: '2026-01-10T10:00:00Z', model: 'example-model',
  inputTokens: 100, cachedInputTokens: 20, outputTokens: 30,
  attempt: 1, outcome: 'success', ticketId: 'API-1',
  provenance: { source: 'usage-export', recordId: 'usage-1' },
};

const valid: SourceBundle = {
  scope: 'API team',
  sourceKind: 'synthetic',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  timezone: 'Europe/Berlin',
  extractedAt: '2027-01-01T10:00:00Z',
  currency: 'EUR',
  completenessAttestation: 'Synthetic example with known source gaps',
  coverage: ['tickets', 'commits', 'usage', 'charges'].map(source => ({
    source, status: 'available', eligible: 1, extracted: 1,
    linked: 1, excluded: 0, missing: 0, reason: '',
  })),
  tickets: [{
    id: 'API-1', type: 'Story', createdAt: '2026-01-02T08:00:00Z',
    startedAt: '2026-01-03T08:00:00Z',
    status: 'approved',
    approvals: [{ at: '2026-01-10T10:00:00Z', releaseId: 'R1' }],
    provenance: { source: 'ticket-export', recordId: 'API-1' },
  }],
  commits: [{
    hash: 'abc123', parents: [], at: '2026-01-09T10:00:00Z',
    paths: ['src/index.ts'], bot: false, ticketIds: ['API-1'],
    provenance: { source: 'commit-export', recordId: 'abc123' },
  }],
  usage: [usage],
  charges: [{
    id: 'charge-1', month: '2026-01', currency: 'EUR', category: 'subscription',
    billId: 'bill-1', billTotal: 75, allocatedTo: 'API team',
    amount: 75, allocationKey: 'team-seat',
    provenance: { source: 'billing-export', recordId: 'charge-1' },
  }],
};

test('returns a valid bundle unchanged', () => {
  assert.strictEqual(validateBundle(valid), valid);
});

test('validates optional report context without confusing update and extraction dates', () => {
  const context = { owner: 'Engineering lead', updatedAt: '2026-09-02',
    description: 'Fictional API service', repositories: ['Synthetic API commit history'],
    aiUse: 'Agent-supported endpoint preparation', question: 'What changed?' };
  assert.strictEqual(validateBundle({ ...valid, context }).context, context);
  for (const invalid of [
    { owner: '  ' }, { updatedAt: '2026-02-30' }, { repositories: [''] },
    { repositories: ['https://example.org/repo'] }, { repositories: ['/home/me/secret'] },
    { repositories: ['C:\\work\\repo'] }, { repositories: ['file:repo'] },
    { repositories: [7] },
    { repositories: ['Safe label'], internalGitPath: '/Users/alice/private-repo', ownerEmail: 'alice@example.org' },
  ]) {
    assert.throws(() => validateBundle({ ...valid, context: invalid } as SourceBundle),
      /context|repositories|updatedAt/i, JSON.stringify(invalid));
  }
});

const monthlyUsage: MonthlyUsage[] = Array.from({ length: 12 }, (_, index) => {
  const month = `2026-${String(index + 1).padStart(2, '0')}`;
  return { kind: 'monthly-total', id: month, month, tokens: (index + 1) * 1_000_000,
    provenance: { source: 'monthly-usage-export', recordId: month } };
});

const rollupBundle = (): SourceBundle => ({ ...valid, usage: monthlyUsage,
  coverage: valid.coverage.map(entry => entry.source === 'usage'
    ? { ...entry, eligible: 12, extracted: 12, linked: 0 } : entry),
});

test('accepts complete monthly token totals without invented event categories', () => {
  const bundle = rollupBundle();
  assert.strictEqual(validateBundle(bundle), bundle);
  assert.equal(bundle.usage?.reduce((sum, record) => sum + ('tokens' in record ? record.tokens : 0), 0), 78_000_000);
});

test('rejects mixed and duplicate monthly usage records', () => {
  assert.throws(() => validateBundle({ ...rollupBundle(), usage: [...monthlyUsage, usage],
    coverage: valid.coverage.map(entry => entry.source === 'usage'
      ? { ...entry, eligible: 13, extracted: 13, linked: 0 } : entry) }), /mixed|one mode/i);
  assert.throws(() => validateBundle({ ...rollupBundle(), usage: [...monthlyUsage.slice(0, 11),
    { ...monthlyUsage[11], id: 'different-id', provenance: { source: 'monthly-usage-export', recordId: 'different-id' }, month: '2026-11' }] }), /duplicate.*month/i);
});

test('rejects malformed rollups and missing months falsely declared available', () => {
  for (const changed of [
    { ...monthlyUsage[0], month: '2026-13' },
    { ...monthlyUsage[0], tokens: -1 },
    { ...monthlyUsage[0], tokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => validateBundle({ ...rollupBundle(), usage: [changed, ...monthlyUsage.slice(1)] }), /month|tokens/i);
  }
  assert.throws(() => validateBundle({ ...rollupBundle(), usage: monthlyUsage.slice(1),
    coverage: valid.coverage.map(entry => entry.source === 'usage'
      ? { ...entry, eligible: 11, extracted: 11, linked: 0 } : entry) }), /missing|month|complete/i);
});

test('empty or overdeclared monthly usage cannot claim complete coverage', () => {
  const empty = { ...valid, usage: [], coverage: valid.coverage.map(entry => entry.source === 'usage'
    ? { ...entry, eligible: 0, extracted: 0, linked: 0 } : entry) };
  assert.throws(() => validateBundle(empty), /usage.*(empty|records|available)/i);
  const exaggerated = { ...rollupBundle(), usage: monthlyUsage.slice(1),
    coverage: valid.coverage.map(entry => entry.source === 'usage'
      ? { ...entry, status: 'partial' as const, eligible: 13, extracted: 11, linked: 0,
        missing: 2, reason: 'September unavailable.' } : entry) };
  assert.throws(() => validateBundle(exaggerated), /usage.*(missing|month|eligible)/i);
});

const recordIds = {
  tickets: 'API-1', commits: 'abc123', usage: 'usage-1', charges: 'charge-1',
};

test('rejects missing provenance on every record source', () => {
  for (const source of ['tickets', 'commits', 'usage', 'charges'] as const) {
    const bundle = structuredClone(valid);
    const item = bundle[source]![0] as unknown as { provenance?: { source: string; recordId: string } };
    delete item.provenance;
    assert.throws(() => validateBundle(bundle), new RegExp(`${source} ${recordIds[source]}: provenance`));
  }
});

test('rejects empty provenance source and recordId on every record source', () => {
  for (const source of ['tickets', 'commits', 'usage', 'charges'] as const) {
    for (const field of ['source', 'recordId'] as const) {
      for (const value of ['', '  ']) {
        const bundle = structuredClone(valid);
        const item = bundle[source]![0] as unknown as { provenance: { source: string; recordId: string } };
        item.provenance[field] = value;
        assert.throws(() => validateBundle(bundle), new RegExp(`${source} ${recordIds[source]}: provenance\\.${field}`));
      }
    }
  }
});

test('rejects duplicate provenance within each record category even when local IDs differ', () => {
  for (const source of ['tickets', 'commits', 'usage', 'charges'] as const) {
    const bundle = structuredClone(valid);
    const original = bundle[source]![0];
    if (source === 'tickets') bundle.tickets!.push({ ...bundle.tickets![0], id: 'API-2' });
    if (source === 'commits') bundle.commits!.push({ ...bundle.commits![0], hash: 'def456' });
    if (source === 'usage') bundle.usage!.push({ ...bundle.usage![0], id: 'usage-2' });
    if (source === 'charges') bundle.charges!.push({ ...bundle.charges![0], id: 'charge-2', month: '2026-02' });
    assert.throws(() => validateBundle(bundle), new RegExp(`${source} .*: provenance.*duplicate`),
      `${source} repeated ${original.provenance.source}/${original.provenance.recordId}`);
  }
});

test('allows the same provenance identity in different record categories', () => {
  const bundle = structuredClone(valid);
  bundle.usage![0].provenance = { ...bundle.tickets![0].provenance };
  assert.strictEqual(validateBundle(bundle), bundle);
});

test('requires a supported source kind and accepts configured bundles', () => {
  const bundle = structuredClone(valid);
  bundle.sourceKind = 'configured';
  assert.strictEqual(validateBundle(bundle), bundle);
  for (const sourceKind of [undefined, 'live', 0]) {
    assert.throws(() => validateBundle({ ...valid, sourceKind } as SourceBundle), /bundle: sourceKind/);
  }
});

test('rejects cached input exceeding input tokens with a record ID', () => {
  assert.throws(() => validateBundle({
    ...valid, usage: [{ ...usage, cachedInputTokens: 101 }],
  }), /usage usage-1: cachedInputTokens/);
});

test('rejects usage without an outcome', () => {
  const bundle = structuredClone(valid);
  const event = bundle.usage?.[0];
  assert.ok(event);
  delete (event as Partial<UsageEvent>).outcome;
  assert.throws(() => validateBundle(bundle), /usage usage-1: outcome/);
});

test('rejects usage outcomes other than success or failed', () => {
  for (const outcome of ['', 'failure', 'pending', 0, null]) {
    assert.throws(() => validateBundle({
      ...valid, usage: [{ ...usage, outcome } as UsageEvent],
    }), /usage usage-1: outcome/, `outcome ${String(outcome)}`);
  }
});

test('rejects duplicate IDs within a source', () => {
  assert.throws(() => validateBundle({
    ...valid, usage: [usage, { ...usage }],
  }), /usage usage-1: duplicate/);
});

test('rejects invalid ISO dates on records and metadata', () => {
  assert.throws(() => validateBundle({
    ...valid, tickets: [{ ...valid.tickets![0], createdAt: '2026-02-30T08:00:00Z' }],
  }), /tickets API-1: createdAt/);
  assert.throws(() => validateBundle({ ...valid, startDate: '2026-02-30' }), /bundle: startDate/);
});

test('requires an explicit ticket status and rejects unsupported values', () => {
  const missing = structuredClone(valid);
  const missingTickets = missing.tickets;
  const approvedTicket = valid.tickets?.[0];
  assert.ok(missingTickets);
  assert.ok(approvedTicket);
  delete (missingTickets[0] as Partial<Ticket>).status;
  assert.throws(() => validateBundle(missing), /tickets API-1: status/);
  for (const status of ['', 'pending', 0, null]) {
    assert.throws(() => validateBundle({
      ...valid, tickets: [{ ...approvedTicket, status } as Ticket],
    }), /tickets API-1: status/, `status ${String(status)}`);
  }
});

test('ticket state agrees with approval evidence', () => {
  const approvedTicket = valid.tickets?.[0];
  assert.ok(approvedTicket);
  for (const status of ['open', 'unknown'] as const) {
    assert.throws(() => validateBundle({
      ...valid, tickets: [{ ...approvedTicket, status }],
    }), /tickets API-1: status/, `${status} with an approval`);
  }
  assert.throws(() => validateBundle({
    ...valid, tickets: [{ ...approvedTicket, status: 'approved', approvals: [] }],
  }), /tickets API-1: status/);
  for (const status of ['open', 'unknown'] as const) {
    const bundle = structuredClone(valid);
    const tickets = bundle.tickets;
    assert.ok(tickets);
    tickets[0] = { ...tickets[0], status, approvals: [] };
    assert.strictEqual(validateBundle(bundle), bundle, `${status} without approval evidence`);
  }
});

test('validates explicit production flags while permitting unknown imported bug environments', () => {
  const base = valid.tickets?.[0];
  assert.ok(base);
  for (const production of [true, false, undefined]) {
    const bundle: SourceBundle = { ...valid, tickets: [{ ...base, type: 'Bug', production }] };
    assert.strictEqual(validateBundle(bundle), bundle);
  }
  for (const production of ['yes', 1, null]) {
    assert.throws(() => validateBundle({ ...valid, tickets: [
      { ...base, type: 'Bug', production } as unknown as Ticket,
    ] }), /tickets API-1: production/);
  }
});

test('validates optional observed commit diagnostics', () => {
  const base = valid.commits?.[0];
  assert.ok(base);
  const observed: SourceBundle = { ...valid, commits: [
    { ...base, linesAdded: 12, linesDeleted: 4, contributorId: 'person-1', changeSize: 16 },
  ] };
  assert.strictEqual(validateBundle(observed), observed);
  for (const field of ['linesAdded', 'linesDeleted', 'changeSize'] as const) {
    for (const value of [-1, 1.5, '12']) {
      assert.throws(() => validateBundle({ ...valid, commits: [
        { ...base, [field]: value },
      ] }), new RegExp(`commits abc123: ${field}`));
    }
  }
  assert.throws(() => validateBundle({ ...valid, commits: [
    { ...base, contributorId: ' ' },
  ] }), /commits abc123: contributorId/);
});

test('rejects charge currency different from bundle currency', () => {
  assert.throws(() => validateBundle({
    ...valid, charges: [{ ...valid.charges![0], currency: 'USD' }],
  }), /charges charge-1: currency/);
});

test('accepts absent optional arrays only when coverage is unavailable', () => {
  const unavailable = {
    ...valid,
    usage: undefined,
    charges: undefined,
    coverage: valid.coverage.map(entry =>
      entry.source === 'usage' || entry.source === 'charges'
        ? { ...entry, status: 'unavailable' as const, eligible: 0, extracted: 0,
            linked: 0, excluded: 0, missing: 0, reason: 'No export provided' }
        : entry),
  };
  assert.strictEqual(validateBundle(unavailable), unavailable);
  assert.throws(() => validateBundle({
    ...unavailable,
    coverage: unavailable.coverage.map(entry =>
      entry.source === 'usage' ? { ...entry, status: 'partial' as const } : entry),
  }), /usage:.*coverage/);
});

test('rejects repeated monthly allocation keys but permits recurring keys in other months', () => {
  const first = valid.charges![0];
  const second = { ...first, id: 'charge-2', provenance: { ...first.provenance, recordId: 'charge-2' } };
  const bundle = { ...valid, coverage: valid.coverage.map(entry => entry.source === 'charges'
    ? { ...entry, eligible: 2, extracted: 2 } : entry) };
  assert.throws(() => validateBundle({
    ...bundle, charges: [first, second],
  }), /charges charge-2:.*allocationKey/);
  assert.strictEqual(validateBundle({
    ...bundle, charges: [first, { ...second, billId: 'bill-2', month: '2026-02' }],
  }).charges?.length, 2);
});

test('validates shared bill totals across distinct allocation keys and consistent bill identity', () => {
  const charge = valid.charges?.[0];
  assert.ok(charge);
  const first = { ...charge, billTotal: 100, amount: 40 };
  const second = { ...first, id: 'charge-2',
    provenance: { source: 'billing-export', recordId: 'charge-2' },
    allocationKey: 'other-team', allocatedTo: 'Other team', amount: 60 };
  const bundle = { ...valid, coverage: valid.coverage.map(entry => entry.source === 'charges'
    ? { ...entry, eligible: 2, extracted: 2 } : entry) };
  assert.strictEqual(validateBundle({ ...bundle, charges: [first, second] }).charges?.length, 2);
  assert.throws(() => validateBundle({ ...bundle, charges: [first, { ...second, amount: 61 }] }),
    /bill-1.*(total|allocat)/i);
  assert.throws(() => validateBundle({ ...bundle, charges: [first, { ...second, billTotal: 101 }] }),
    /bill-1.*metadata/i);
  assert.throws(() => validateBundle({ ...bundle, charges: [{ ...first, billId: '' }] }), /billId/);
});

test('one bill can allocate across categories and full reporting months without duplicating its total', () => {
  const first = valid.charges?.[0];
  assert.ok(first);
  const allocations = [
    { ...first, billTotal: 100, amount: 60 },
    { ...first, id: 'charge-2', provenance: { source: 'billing-export', recordId: 'charge-2' },
      month: '2026-02', category: 'consumption', allocationKey: 'february-consumption',
      allocatedTo: 'Other team', billTotal: 100, amount: 40 },
  ];
  const bundle = { ...valid, coverage: valid.coverage.map(entry => entry.source === 'charges'
    ? { ...entry, eligible: 2, extracted: 2 } : entry) };
  assert.strictEqual(validateBundle({ ...bundle, charges: allocations }).charges?.length, 2);
  assert.throws(() => validateBundle({ ...bundle, charges: [allocations[0], { ...allocations[1], amount: 41 }] }),
    /bill-1.*(total|allocat)/i);
});

test('configured reporting windows must begin and end on complete calendar months', () => {
  const configured = { ...valid, sourceKind: 'configured' as const };
  assert.strictEqual(validateBundle(configured), configured);
  for (const startDate of ['2026-01-02', '2026-02-15']) {
    assert.throws(() => validateBundle({ ...configured, startDate }), /startDate.*first day|full month/i);
  }
  for (const endDate of ['2026-11-29', '2026-12-30']) {
    assert.throws(() => validateBundle({ ...configured, endDate }), /endDate.*last day|full month/i);
  }
  const leapMonth = { ...configured, startDate: '2028-02-01', endDate: '2028-02-29' };
  assert.strictEqual(validateBundle(leapMonth), leapMonth);
  assert.throws(() => validateBundle({ ...leapMonth, endDate: '2028-02-28' }), /endDate.*last day|full month/i);
});

test('rejects invalid timezone, reversed bounds and unparseable extraction timestamp', () => {
  assert.throws(() => validateBundle({ ...valid, timezone: 'Not/AZone' }), /bundle: timezone/);
  assert.throws(() => validateBundle({ ...valid, endDate: '2025-12-31' }), /bundle:.*endDate/);
  assert.throws(() => validateBundle({ ...valid, extractedAt: 'yesterday' }), /bundle: extractedAt/);
});

test('rejects missing parents and approval events before work began', () => {
  assert.throws(() => validateBundle({
    ...valid, tickets: [{ ...valid.tickets![0], parentId: 'API-missing' }],
  }), /tickets API-1: parentId/);
  assert.throws(() => validateBundle({
    ...valid, tickets: [{ ...valid.tickets![0], approvals: [{ at: '2026-01-01T10:00:00Z', releaseId: 'R1' }] }],
  }), /tickets API-1: approvals/);
});

test('rejects invalid coverage counts and missing source coverage', () => {
  assert.throws(() => validateBundle({
    ...valid, coverage: valid.coverage.map(entry =>
      entry.source === 'usage' ? { ...entry, missing: -1 } : entry),
  }), /coverage usage: missing/);
  assert.throws(() => validateBundle({
    ...valid, coverage: valid.coverage.filter(entry => entry.source !== 'usage'),
  }), /usage:.*coverage/);
});

test('coverage missing counts require incomplete status and a reason for every source kind', () => {
  for (const sourceKind of ['synthetic', 'configured'] as const) {
    const bundle = structuredClone(valid);
    bundle.sourceKind = sourceKind;
    const usageCoverage = bundle.coverage.find(entry => entry.source === 'usage')!;
    Object.assign(usageCoverage, { eligible: 2, missing: 1 });
    assert.throws(() => validateBundle(bundle), /coverage usage: available.*missing/i);
    usageCoverage.status = 'partial';
    assert.throws(() => validateBundle(bundle), /coverage usage: reason/i);
    usageCoverage.reason = 'One eligible event not exported';
    assert.strictEqual(validateBundle(bundle), bundle);
    usageCoverage.eligible = 3;
    assert.throws(() => validateBundle(bundle), /coverage usage: eligible.*reconcile/i);
  }
});

test('shared coverage extracted counts match returned records', () => {
  for (const sourceKind of ['synthetic', 'configured'] as const) {
    const bundle = structuredClone(valid);
    bundle.sourceKind = sourceKind;
    bundle.coverage = bundle.coverage.map(entry => entry.source === 'usage'
      ? { ...entry, eligible: 2, extracted: 2 }
      : entry);
    assert.throws(() => validateBundle(bundle), /usage.*extracted.*records/i);
  }
});

test('rejects contradictory coverage totals without requiring every extracted record to be linked', () => {
  const cases = [
    { status: 'unavailable' as const, extracted: 1, linked: 0, excluded: 0 },
    { status: 'unavailable' as const, extracted: 0, linked: 1, excluded: 0 },
    { status: 'unavailable' as const, extracted: 0, linked: 0, excluded: 1 },
    { status: 'available' as const, extracted: 1, linked: 2, excluded: 0 },
    { status: 'available' as const, extracted: 1, linked: 0, excluded: 2 },
    { status: 'available' as const, extracted: 2, linked: 2, excluded: 1 },
    { status: 'available' as const, eligible: 0, extracted: 1, linked: 1, excluded: 0 },
  ];
  for (const counts of cases) {
    const bundle = structuredClone(valid);
    bundle.coverage = bundle.coverage.map(entry => entry.source === 'usage'
      ? { ...entry, ...counts, reason: counts.status === 'unavailable' ? 'No export' : '' }
      : entry);
    if (counts.status === 'unavailable') bundle.usage = undefined;
    assert.throws(() => validateBundle(bundle), /coverage usage: (extracted|linked|excluded)/,
      JSON.stringify(counts));
  }
  const bundle = structuredClone(valid);
  bundle.coverage = bundle.coverage.map(entry => entry.source === 'usage'
    ? { ...entry, status: 'partial', eligible: 2, extracted: 1, linked: 0, excluded: 0,
        missing: 1, reason: 'One eligible event not exported' }
    : entry);
  assert.strictEqual(validateBundle(bundle), bundle);
});