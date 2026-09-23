import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTicketFile } from '../src/adapters/files.js';
import { loadConfigured } from '../src/adapters/load.js';
import { loadSynthetic } from '../src/adapters/synthetic.js';
import { isMonthlyUsage, type UsageEvent } from '../src/model.js';

test('ticket export retains parent, child, ordered approvals and release IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const ticketPath = join(directory, 'tickets.json');
    await writeFile(ticketPath, JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z',
        statusEvents: [
          { at: '2026-03-02T09:00:00Z', status: 'open' },
          { at: '2026-03-20T09:00:00Z', status: 'approved', releaseId: 'R1' },
          { at: '2026-03-25T09:00:00Z', status: 'approved', releaseId: 'R2' },
        ] },
      { id: 'API-103', type: 'Sub-task', parentId: 'API-101',
        createdAt: '2026-03-03T09:00:00Z', statusEvents: [] },
    ] }));
    const tickets = await loadTicketFile(ticketPath);
    assert.equal(tickets[1].parentId, 'API-101');
    assert.equal(tickets[1].status, 'unknown');
    assert.equal(tickets[0].status, 'approved');
    assert.deepEqual(tickets[0].approvals, [
      { at: '2026-03-20T09:00:00Z', releaseId: 'R1' },
      { at: '2026-03-25T09:00:00Z', releaseId: 'R2' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const config = {
  version: 1, scope: 'Example API team', startDate: '2026-03-01', endDate: '2026-03-31',
  timezone: 'UTC', extractedAt: '2026-04-01T00:00:00Z', currency: 'EUR',
  completenessAttestation: 'Only declared sources were extracted.',
  sources: { tickets: { kind: 'file', path: 'tickets.json', coverage: {
    status: 'available', eligible: 2, extracted: 2, linked: 0, excluded: 0,
    missing: 0, reason: '',
  } } },
};

test('configured report context is optional and never replaced with the synthetic profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-context-'));
  try {
    const configPath = join(directory, 'config.json');
    const context = { owner: 'Example lead', updatedAt: '2026-04-02',
      description: 'Example service', repositories: ['Service source history'],
      question: 'What changed in the reporting month?' };
    await writeFile(configPath, JSON.stringify({ ...config, sources: {}, context }));
    const configured = await loadConfigured(configPath);
    assert.deepEqual(configured.context, context);
    await writeFile(configPath, JSON.stringify({ ...config, sources: {} }));
    assert.equal((await loadConfigured(configPath)).context, undefined);
    const synthetic = loadSynthetic();
    assert.match(synthetic.context?.description ?? '', /fictional|synthetic/i);
    assert.ok(synthetic.context?.repositories?.every(label => /synthetic/i.test(label)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configured synthetic selectors cannot relabel fixture coverage or blend with live sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const fixture = loadSynthetic();
    const configPath = join(directory, 'config.json');
    for (const [metadata, sources] of [
      [{ ...fixture, startDate: '2027-01-01', endDate: '2027-12-31' },
        { tickets: { kind: 'synthetic' } }],
      [{ ...fixture, scope: 'Unrelated team' }, { charges: { kind: 'synthetic' } }],
      [fixture, { usage: { kind: 'synthetic' }, commits: { kind: 'git', path: 'repo', revision: 'HEAD' } }],
    ] as const) {
      await writeFile(configPath, JSON.stringify({ ...metadata, version: 1, sources }));
      await assert.rejects(loadConfigured(configPath), /configured synthetic.*not supported/i);
    }
    assert.equal(loadSynthetic().coverage.find(entry => entry.source === 'charges')?.status, 'available');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configured ticket file preserves provenance and leaves other sources unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'tickets.json'), JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z',
        statusEvents: [{ at: '2026-03-20T09:00:00Z', status: 'approved', releaseId: 'R1' },
          { at: '2026-03-25T09:00:00Z', status: 'approved', releaseId: 'R2' }] },
      { id: 'API-103', type: 'Sub-task', parentId: 'API-101',
        createdAt: '2026-03-03T09:00:00Z', statusEvents: [] },
    ] }));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const bundle = await loadConfigured(configPath);
    assert.equal(bundle.sourceKind, 'configured');
    assert.equal(bundle.tickets?.find(ticket => ticket.id === 'API-103')?.parentId, 'API-101');
    assert.deepEqual(bundle.tickets?.[0].approvals.map(approval => approval.releaseId), ['R1', 'R2']);
    assert.deepEqual(bundle.tickets?.[0].provenance, { source: 'file:tickets', recordId: 'API-101' });
    assert.equal(bundle.usage, undefined);
    assert.equal(bundle.charges, undefined);
    assert.equal(bundle.commits, undefined);
    assert.deepEqual(bundle.coverage.filter(entry => entry.status === 'unavailable').map(entry => entry.source),
      ['commits', 'usage', 'charges']);
    assert.deepEqual(bundle.sources?.tickets, config.sources.tickets);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file selector preserves declared partial coverage for an incomplete export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'tickets.json'), JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z', statusEvents: [] },
    ] }));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config, sources: { tickets: {
      kind: 'file', path: 'tickets.json', coverage: {
        status: 'partial', eligible: 2, extracted: 1, linked: 0, excluded: 0,
        missing: 1, reason: 'One eligible ticket was not exported',
      },
    } } }));
    const bundle = await loadConfigured(configPath);
    assert.deepEqual(bundle.coverage.find(entry => entry.source === 'tickets'), {
      source: 'tickets', status: 'partial', eligible: 2, extracted: 1, linked: 0,
      excluded: 0, missing: 1, reason: 'One eligible ticket was not exported',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file imports require explicit coverage rather than inferring completeness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'tickets.json'), JSON.stringify({ version: 1, tickets: [] }));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config,
      sources: { tickets: { kind: 'file', path: 'tickets.json' } },
    }));
    await assert.rejects(loadConfigured(configPath), /tickets.*coverage.*required/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file coverage must match exported records and reconcile eligible with missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'tickets.json'), JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z', statusEvents: [] },
    ] }));
    const configPath = join(directory, 'config.json');
    const coverage = { status: 'partial', eligible: 2, extracted: 0, linked: 0,
      excluded: 0, missing: 2, reason: 'One missing ticket' };
    await writeFile(configPath, JSON.stringify({ ...config, sources: { tickets: {
      kind: 'file', path: 'tickets.json', coverage,
    } } }));
    await assert.rejects(loadConfigured(configPath), /tickets.*extracted.*records/i);
    await writeFile(configPath, JSON.stringify({ ...config, sources: { tickets: {
      kind: 'file', path: 'tickets.json', coverage: { ...coverage, extracted: 1, missing: 0 },
    } } }));
    await assert.rejects(loadConfigured(configPath), /tickets.*eligible.*missing/i);
    await writeFile(configPath, JSON.stringify({ ...config, sources: { tickets: {
      kind: 'file', path: 'tickets.json', coverage: { ...coverage, status: 'available', extracted: 1, missing: 1 },
    } } }));
    await assert.rejects(loadConfigured(configPath), /tickets.*available.*missing/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('module and file sources reject incomplete exports declared as available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const configPath = join(directory, 'config.json');
    await writeFile(join(directory, 'tickets.json'), JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z', statusEvents: [] },
    ] }));
    await writeFile(join(directory, 'tickets.mjs'), `export async function loadSource() {
      return { tickets: [{ id: 'API-101', type: 'Story', status: 'open',
        createdAt: '2026-03-01T09:00:00Z', approvals: [],
        provenance: { source: 'module', recordId: 'API-101' } }],
        coverage: [{ source: 'tickets', status: 'available', eligible: 2, extracted: 1,
          linked: 0, excluded: 0, missing: 1, reason: '' }] };
    }`);
    const coverage = { status: 'available', eligible: 2, extracted: 1,
      linked: 0, excluded: 0, missing: 1, reason: '' };
    for (const selector of [
      { kind: 'module', path: 'tickets.mjs' },
      { kind: 'file', path: 'tickets.json', coverage },
    ]) {
      await writeFile(configPath, JSON.stringify({ ...config, sources: { tickets: selector } }));
      await assert.rejects(loadConfigured(configPath), /tickets.*available.*missing/i);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing or malformed configured files reject with the source path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(loadConfigured(configPath), /tickets.*tickets\.json/);
    await writeFile(join(directory, 'tickets.json'), JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z',
        statusEvents: [{ at: '2026-03-20T09:00:00Z', status: 'approved' }] },
    ] }));
    await assert.rejects(loadConfigured(configPath), /tickets.*API-101.*releaseId/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct ticket import rejects invalid timestamps with the ticket ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const path = join(directory, 'tickets.json');
    await writeFile(path, JSON.stringify({ version: 1, tickets: [
      { id: 'API-101', type: 'Story', createdAt: 'not-a-date', statusEvents: [] },
    ] }));
    await assert.rejects(loadTicketFile(path), /tickets.*API-101.*createdAt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ticket open history may precede start but approval must follow start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const ticketPath = join(directory, 'tickets.json');
    const ticket = { id: 'API-101', type: 'Story', createdAt: '2026-03-01T09:00:00Z',
      startedAt: '2026-03-10T09:00:00Z', statusEvents: [
        { at: '2026-03-02T09:00:00Z', status: 'open' },
        { at: '2026-03-11T09:00:00Z', status: 'approved', releaseId: 'R1' },
      ] };
    await writeFile(ticketPath, JSON.stringify({ version: 1, tickets: [ticket] }));
    const [loaded] = await loadTicketFile(ticketPath);
    assert.equal(loaded.status, 'approved');
    assert.deepEqual(loaded.approvals, [{ at: '2026-03-11T09:00:00Z', releaseId: 'R1' }]);
    await writeFile(ticketPath, JSON.stringify({ version: 1, tickets: [{ ...ticket,
      statusEvents: [ticket.statusEvents[0], { at: '2026-03-09T09:00:00Z',
        status: 'approved', releaseId: 'R1' }],
    }] }));
    await assert.rejects(loadTicketFile(ticketPath), /API-101.*approval.*startedAt/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('trusted module receives config and returns validated partial coverage without synthetic fill', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'adapter.mjs'), `export async function loadSource(config) {
      return { tickets: [{ id: 'API-900', type: 'Story', status: 'open',
        createdAt: '2026-03-02T09:00:00Z', approvals: [],
        provenance: { source: config.scope, recordId: 'API-900' } }],
        coverage: [{ source: 'tickets', status: 'partial', eligible: 2, extracted: 1,
          linked: 0, excluded: 0, missing: 1, reason: 'One ticket not exported' }] };
    }`);
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config,
      sources: { tickets: { kind: 'module', path: 'adapter.mjs' } },
    }));
    const bundle = await loadConfigured(configPath);
    assert.equal(bundle.tickets?.[0].provenance.source, 'Example API team');
    assert.equal(bundle.coverage.find(entry => entry.source === 'tickets')?.status, 'partial');
    assert.equal(bundle.coverage.find(entry => entry.source === 'tickets')?.missing, 1);
    assert.equal(bundle.usage, undefined);
    assert.equal(bundle.charges, undefined);
    assert.deepEqual(bundle.sources?.tickets, { kind: 'module', path: 'adapter.mjs' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('structured usage and billing retain retries and bill allocation fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'usage.json'), JSON.stringify({ version: 1, usage: [
      { id: 'attempt-1', at: '2026-03-18T10:00:00Z', model: 'example-model', inputTokens: 100,
        cachedInputTokens: 40, outputTokens: 0, attempt: 1, outcome: 'failed' },
      { id: 'attempt-2', at: '2026-03-18T10:01:00Z', model: 'example-model', inputTokens: 80,
        cachedInputTokens: 20, outputTokens: 20, attempt: 2, outcome: 'success' },
    ] }));
    await writeFile(join(directory, 'billing.json'), JSON.stringify({ version: 1, charges: [
      { id: 'C-1', billId: 'B-1', billTotal: 50, allocatedTo: 'Example API team',
        month: '2026-03', currency: 'EUR', category: 'consumption', amount: 50,
        allocationKey: 'api-team' },
    ] }));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config, sources: {
      usage: { kind: 'file', path: 'usage.json', coverage: {
        status: 'available', eligible: 2, extracted: 2, linked: 0, excluded: 0, missing: 0, reason: '',
      } },
      charges: { kind: 'file', path: 'billing.json', coverage: {
        status: 'available', eligible: 1, extracted: 1, linked: 0, excluded: 0, missing: 0, reason: '',
      } },
    } }));
    const bundle = await loadConfigured(configPath);
    assert.deepEqual(bundle.usage?.filter((event): event is UsageEvent => !isMonthlyUsage(event))
      .map(event => [event.id, event.outcome, event.cachedInputTokens]),
      [['attempt-1', 'failed', 40], ['attempt-2', 'success', 20]]);
    assert.deepEqual(bundle.charges?.map(charge => [charge.billId, charge.billTotal, charge.allocatedTo]),
      [['B-1', 50, 'Example API team']]);
    assert.equal(bundle.tickets, undefined);
    assert.equal(bundle.coverage.find(entry => entry.source === 'tickets')?.status, 'unavailable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('structured monthly token totals import without event details and reject mixed records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-monthly-usage-'));
  try {
    const record = { kind: 'monthly-total', id: 'march-total', month: '2026-03', tokens: 12_000_000 };
    await writeFile(join(directory, 'usage.json'), JSON.stringify({ version: 1, usage: [record] }));
    const configPath = join(directory, 'config.json');
    const source = { kind: 'file', path: 'usage.json', coverage: {
      status: 'available', eligible: 1, extracted: 1, linked: 0, excluded: 0, missing: 0, reason: '',
    } };
    await writeFile(configPath, JSON.stringify({ ...config, sources: { usage: source } }));
    const bundle = await loadConfigured(configPath);
    assert.deepEqual(bundle.usage, [{ ...record,
      provenance: { source: 'file:usage', recordId: 'march-total' } }]);
    await writeFile(join(directory, 'usage.json'), JSON.stringify({ version: 1, usage: [record,
      { id: 'event', at: '2026-03-18T10:00:00Z', model: 'model-a', inputTokens: 100,
        cachedInputTokens: 0, outputTokens: 20, attempt: 1, outcome: 'success' }] }));
    await writeFile(configPath, JSON.stringify({ ...config, sources: { usage: { ...source,
      coverage: { ...source.coverage, eligible: 2, extracted: 2 } } } }));
    await assert.rejects(loadConfigured(configPath), /mixed usage modes/i);
    await writeFile(join(directory, 'usage.json'), JSON.stringify({ version: 1, usage: [
      { ...record, model: 'invented-model', ticketId: 'API-101' }] }));
    await writeFile(configPath, JSON.stringify({ ...config, sources: { usage: source } }));
    await assert.rejects(loadConfigured(configPath), /monthly.*(detail|model|ticket)/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('module records are subject to the same record validation as file imports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'bad.mjs'), `export async function loadSource() {
      return { usage: [{ id: 'bad-event', at: '2026-03-18T10:00:00Z', model: 'example-model',
        inputTokens: 10, cachedInputTokens: 11, outputTokens: 1, attempt: 1,
        outcome: 'success', provenance: { source: 'module-usage', recordId: 'bad-event' } }],
        coverage: [{ source: 'usage', status: 'available', eligible: 1, extracted: 1,
          linked: 0, excluded: 0, missing: 0, reason: '' }] };
    }`);
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config,
      sources: { usage: { kind: 'module', path: 'bad.mjs' } },
    }));
    await assert.rejects(loadConfigured(configPath), /usage bad-event: cachedInputTokens/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom module must disclose source coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    await writeFile(join(directory, 'missing-coverage.mjs'), `export async function loadSource() {
      return { tickets: [{ id: 'API-901', type: 'Story', status: 'open',
        createdAt: '2026-03-02T09:00:00Z', approvals: [],
        provenance: { source: 'custom', recordId: 'API-901' } }] };
    }`);
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config,
      sources: { tickets: { kind: 'module', path: 'missing-coverage.mjs' } },
    }));
    await assert.rejects(loadConfigured(configPath), /tickets.*coverage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('module coverage extracted must match every returned source array', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const configPath = join(directory, 'config.json');
    const examples = {
      tickets: { id: 'API-901', type: 'Story', status: 'open',
        createdAt: '2026-03-02T09:00:00Z', approvals: [],
        provenance: { source: 'custom', recordId: 'API-901' } },
      commits: { hash: 'abc123', parents: [], at: '2026-03-02T09:00:00Z',
        paths: [], bot: false, ticketIds: [], provenance: { source: 'custom', recordId: 'abc123' } },
      usage: { id: 'U-1', at: '2026-03-02T09:00:00Z', model: 'example',
        inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, attempt: 1, outcome: 'success',
        provenance: { source: 'custom', recordId: 'U-1' } },
      charges: { id: 'C-1', billId: 'B-1', billTotal: 1, allocatedTo: 'Example API team',
        month: '2026-03', currency: 'EUR', category: 'consumption', amount: 1,
        allocationKey: 'example', provenance: { source: 'custom', recordId: 'C-1' } },
    };
    for (const source of ['tickets', 'commits', 'usage', 'charges'] as const) {
      const moduleName = `${source}-wrong-count.mjs`;
      await writeFile(join(directory, moduleName), `export async function loadSource() {
        return ${JSON.stringify({ [source]: [examples[source]], coverage: [
          { source, status: 'partial', eligible: 1, extracted: 0,
            linked: 0, excluded: 0, missing: 1, reason: 'Incomplete export' },
        ] })};
      }`);
      await writeFile(configPath, JSON.stringify({ ...config,
        sources: { [source]: { kind: 'module', path: moduleName } },
      }));
      await assert.rejects(loadConfigured(configPath), new RegExp(`${source}.*extracted.*records`, 'i'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Git selector rejects a missing repository instead of borrowing synthetic commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impact-adapters-'));
  try {
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ ...config,
      sources: { commits: { kind: 'git', path: 'repo', revision: 'HEAD' } },
    }));
    await assert.rejects(loadConfigured(configPath), /commits git.*Invalid local Git repository path or revision/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shipped structured ticket and module examples load from their versioned configs', async () => {
  const examples = fileURLToPath(new URL('../../examples/', import.meta.url));
  const ticketBundle = await loadConfigured(join(examples, 'config.json'));
  assert.equal(ticketBundle.tickets?.find(ticket => ticket.id === 'API-103')?.parentId, 'API-101');
  assert.deepEqual(ticketBundle.tickets?.find(ticket => ticket.id === 'API-101')?.approvals.map(event => event.releaseId),
    ['EXAMPLE-R1', 'EXAMPLE-R2']);
  assert.equal(ticketBundle.usage, undefined);
  const moduleBundle = await loadConfigured(join(examples, 'module-config.json'));
  assert.equal(moduleBundle.tickets?.[0].id, 'API-901');
  assert.equal(moduleBundle.charges, undefined);
});