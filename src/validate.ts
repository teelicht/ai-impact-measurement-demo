import { isMonthlyUsage, type SourceBundle } from './model.js';
import { reconcileCharges } from './finance.js';

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: must be an object`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}: must be a nonempty string`);
  }
  return value;
}

function array(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: must be an array`);
  }
}

function count(value: unknown, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label}: must be a safe integer >= ${minimum}`);
  }
}

function date(value: unknown, label: string): string {
  const valueText = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText) ||
      Number.isNaN(Date.parse(`${valueText}T00:00:00Z`)) ||
      new Date(`${valueText}T00:00:00Z`).toISOString().slice(0, 10) !== valueText) {
    throw new Error(`${label}: must be an ISO calendar date`);
  }
  return valueText;
}

export function timestamp(value: unknown, label: string): string {
  const valueText = text(value, label);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(valueText);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 ||
      Number(match[4]) > 59 || Number(match[6]) > 23 || Number(match[7]) > 59 ||
      !Number.isFinite(Date.parse(valueText))) {
    throw new Error(`${label}: must be an ISO timestamp with timezone`);
  }
  date(match[1], label);
  return valueText;
}

function unique(seen: Set<string>, key: string, label: string): void {
  if (seen.has(key)) {
    throw new Error(`${label}: duplicate record`);
  }
  seen.add(key);
}

function strings(value: unknown, label: string): void {
  array(value, label);
  value.forEach((item, index) => { text(item, `${label}[${index}]`); });
}

function provenance(value: unknown, label: string): string {
  record(value, `${label}: provenance`);
  const source = text(value.source, `${label}: provenance.source`);
  const recordId = text(value.recordId, `${label}: provenance.recordId`);
  return JSON.stringify([source, recordId]);
}

export function validateBundle(bundle: SourceBundle): SourceBundle {
  record(bundle, 'bundle');
  text(bundle.scope, 'bundle: scope');
  if (bundle.sourceKind !== 'synthetic' && bundle.sourceKind !== 'configured') {
    throw new Error('bundle: sourceKind must be synthetic or configured');
  }
  const startDate = date(bundle.startDate, 'bundle: startDate');
  const endDate = date(bundle.endDate, 'bundle: endDate');
  if (startDate > endDate) {
    throw new Error('bundle: endDate must not precede startDate');
  }
  if (bundle.sourceKind === 'configured') {
    if (!startDate.endsWith('-01')) {
      throw new Error('bundle: startDate must be the first day of a full month');
    }
    const lastDay = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
    lastDay.setUTCDate(0);
    if (endDate !== lastDay.toISOString().slice(0, 10)) {
      throw new Error('bundle: endDate must be the last day of a full month');
    }
  }
  const timezone = text(bundle.timezone, 'bundle: timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('bundle: timezone must be valid');
  }
  timestamp(bundle.extractedAt, 'bundle: extractedAt');
  if (bundle.context !== undefined) {
    record(bundle.context, 'bundle: context');
    const contextFields = ['owner', 'description', 'includedWork', 'excludedWork', 'aiUse',
      'concurrentChanges', 'question', 'controls', 'resourceLimits'] as const;
    const allowed = new Set<string>([...contextFields, 'updatedAt', 'repositories']);
    for (const field of Object.keys(bundle.context)) {
      if (!allowed.has(field)) throw new Error(`context: unsupported field ${field}`);
    }
    for (const field of contextFields) {
      if (bundle.context[field] !== undefined) text(bundle.context[field], `context: ${field}`);
    }
    if (bundle.context.updatedAt !== undefined) date(bundle.context.updatedAt, 'context: updatedAt');
    if (bundle.context.repositories !== undefined) {
      array(bundle.context.repositories, 'context: repositories');
      bundle.context.repositories.forEach((label, index) => {
        const name = text(label, `context: repositories[${index}]`);
        if (/[/\\@]/.test(name) || /[a-z][a-z0-9+.-]*:/i.test(name) ||
          Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
          throw new Error(`context: repositories[${index}] must be a display label, not a path or URL`);
        }
      });
    }
  }
  const currency = text(bundle.currency, 'bundle: currency');
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('bundle: currency must be an ISO currency code');
  }
  text(bundle.completenessAttestation, 'bundle: completenessAttestation');

  array(bundle.coverage, 'bundle: coverage');
  const covered = new Map<string, string>();
  for (const entry of bundle.coverage) {
    record(entry, 'coverage');
    const source = text(entry.source, 'coverage: source');
    const label = `coverage ${source}`;
    if (covered.has(source)) {
      throw new Error(`${label}: duplicate source`);
    }
    if (entry.status !== 'available' && entry.status !== 'partial' && entry.status !== 'unavailable') {
      throw new Error(`${label}: status must be available, partial or unavailable`);
    }
    for (const field of ['eligible', 'extracted', 'linked', 'excluded', 'missing'] as const) {
      count(entry[field], `${label}: ${field}`);
    }
    if (entry.status === 'unavailable') {
      for (const field of ['extracted', 'linked', 'excluded'] as const) {
        if (entry[field] !== 0) throw new Error(`${label}: ${field} must be zero when unavailable`);
      }
    }
    if (entry.excluded > entry.extracted) {
      throw new Error(`${label}: excluded cannot exceed extracted`);
    }
    if (entry.linked > entry.extracted - entry.excluded) {
      throw new Error(`${label}: linked and excluded cannot exceed extracted`);
    }
    if (entry.linked > entry.eligible) {
      throw new Error(`${label}: linked cannot exceed eligible`);
    }
    if (entry.eligible !== entry.extracted - entry.excluded + entry.missing) {
      throw new Error(`${label}: eligible must reconcile with extracted, excluded and missing`);
    }
    if (entry.status === 'available' && entry.missing !== 0) {
      throw new Error(`${label}: available coverage cannot report missing records`);
    }
    if (typeof entry.reason !== 'string' ||
        (entry.status !== 'available' && entry.reason.trim() === '')) {
      throw new Error(`${label}: reason is required for incomplete coverage`);
    }
    covered.set(source, entry.status);
  }

  for (const source of ['tickets', 'commits', 'usage', 'charges'] as const) {
    const status = covered.get(source);
    if (!status) {
      throw new Error(`${source}: missing coverage`);
    }
    const records = bundle[source];
    if (status === 'unavailable') {
      if (records !== undefined) {
        throw new Error(`${source}: unavailable coverage cannot include records`);
      }
    } else if (records === undefined) {
      throw new Error(`${source}: ${status} coverage requires a records array`);
    } else {
      array(records, `${source}: records`);
      if (source === 'usage' && status === 'available' && records.length === 0) {
        throw new Error('usage: empty available source cannot establish monthly consumption');
      }
    }
  }

  const ticketIds = new Set<string>();
  const ticketProvenance = new Set<string>();
  for (const ticket of bundle.tickets ?? []) {
    record(ticket, 'tickets');
    const id = text(ticket.id, 'tickets: id');
    const label = `tickets ${id}`;
    unique(ticketIds, id, label);
    unique(ticketProvenance, provenance(ticket.provenance, label), `${label}: provenance`);
    text(ticket.type, `${label}: type`);
    if (ticket.status !== 'open' && ticket.status !== 'approved' && ticket.status !== 'unknown') {
      throw new Error(`${label}: status must be open, approved or unknown`);
    }
    const createdAt = timestamp(ticket.createdAt, `${label}: createdAt`);
    if (ticket.parentId !== undefined) text(ticket.parentId, `${label}: parentId`);
    if (ticket.emergency !== undefined && typeof ticket.emergency !== 'boolean') {
      throw new Error(`${label}: emergency must be boolean`);
    }
    if (ticket.production !== undefined && typeof ticket.production !== 'boolean') {
      throw new Error(`${label}: production must be boolean`);
    }
    let previousAt = createdAt;
    if (ticket.startedAt !== undefined) {
      timestamp(ticket.startedAt, `${label}: startedAt`);
      if (Date.parse(ticket.startedAt) < Date.parse(createdAt)) {
        throw new Error(`${label}: startedAt precedes createdAt`);
      }
      previousAt = ticket.startedAt;
    }
    array(ticket.approvals, `${label}: approvals`);
    if ((ticket.status === 'approved') !== (ticket.approvals.length > 0)) {
      throw new Error(`${label}: status must agree with approval evidence`);
    }
    for (const approval of ticket.approvals) {
      record(approval, `${label}: approvals`);
      const at = timestamp(approval.at, `${label}: approvals.at`);
      text(approval.releaseId, `${label}: approvals.releaseId`);
      if (Date.parse(at) < Date.parse(previousAt)) {
        throw new Error(`${label}: approvals must follow work events in order`);
      }
      previousAt = at;
    }
  }
  const parents = new Map((bundle.tickets ?? []).map(ticket => [ticket.id, ticket.parentId]));
  for (const ticket of bundle.tickets ?? []) {
    const visited = new Set([ticket.id]);
    let parentId = ticket.parentId;
    while (parentId !== undefined) {
      if (!ticketIds.has(parentId) || visited.has(parentId)) {
        throw new Error(`tickets ${ticket.id}: parentId must identify an existing acyclic parent`);
      }
      visited.add(parentId);
      parentId = parents.get(parentId);
    }
  }

  const commitHashes = new Set<string>();
  const commitProvenance = new Set<string>();
  for (const commit of bundle.commits ?? []) {
    record(commit, 'commits');
    const hash = text(commit.hash, 'commits: hash');
    const label = `commits ${hash}`;
    unique(commitHashes, hash, label);
    unique(commitProvenance, provenance(commit.provenance, label), `${label}: provenance`);
    strings(commit.parents, `${label}: parents`);
    timestamp(commit.at, `${label}: at`);
    strings(commit.paths, `${label}: paths`);
    if (typeof commit.bot !== 'boolean') throw new Error(`${label}: bot must be boolean`);
    strings(commit.ticketIds, `${label}: ticketIds`);
    for (const field of ['linesAdded', 'linesDeleted', 'changeSize', 'testLinesAdded', 'sourceLinesAdded'] as const) {
      if (commit[field] !== undefined) count(commit[field], `${label}: ${field}`);
    }
    if (commit.contributorId !== undefined) text(commit.contributorId, `${label}: contributorId`);
  }

  const usageIds = new Set<string>();
  const usageProvenance = new Set<string>();
  const rollupMonths = new Set<string>();
  const hasRollups = bundle.usage?.some(isMonthlyUsage) ?? false;
  for (const event of bundle.usage ?? []) {
    record(event, 'usage');
    const id = text(event.id, 'usage: id');
    const label = `usage ${id}`;
    unique(usageIds, id, label);
    unique(usageProvenance, provenance(event.provenance, label), `${label}: provenance`);
    if (isMonthlyUsage(event)) {
      date(`${text(event.month, `${label}: month`)}-01`, `${label}: month`);
      if (event.month < startDate.slice(0, 7) || event.month > endDate.slice(0, 7)) {
        throw new Error(`${label}: month outside reporting window`);
      }
      unique(rollupMonths, event.month, `${label}: duplicate month`);
      count(event.tokens, `${label}: tokens`);
      if (['model', 'at', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'attempt', 'outcome', 'ticketId']
        .some(field => field in event)) throw new Error(`${label}: monthly totals cannot contain event detail`);
      continue;
    }
    if (hasRollups) throw new Error(`${label}: mixed usage modes are not supported`);
    timestamp(event.at, `${label}: at`);
    text(event.model, `${label}: model`);
    count(event.inputTokens, `${label}: inputTokens`);
    count(event.outputTokens, `${label}: outputTokens`);
    if (!Number.isSafeInteger(event.cachedInputTokens) || event.cachedInputTokens < 0 ||
        event.cachedInputTokens > event.inputTokens) {
      throw new Error(`${label}: cachedInputTokens must be within inputTokens`);
    }
    count(event.attempt, `${label}: attempt`, 1);
    if (event.outcome !== 'success' && event.outcome !== 'failed') {
      throw new Error(`${label}: outcome must be success or failed`);
    }
    if (event.ticketId !== undefined) text(event.ticketId, `${label}: ticketId`);
  }
  if (hasRollups) {
    const months = (Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 +
      Number(endDate.slice(5, 7)) - Number(startDate.slice(5, 7)) + 1;
    const missingMonths = months - rollupMonths.size;
    const usageCoverage = bundle.coverage.find(entry => entry.source === 'usage');
    if (!usageCoverage || usageCoverage.missing !== missingMonths || usageCoverage.eligible !== months ||
        usageCoverage.linked !== 0 || usageCoverage.excluded !== 0 ||
        (missingMonths > 0 && usageCoverage.status === 'available')) {
      throw new Error(`usage: coverage must account for exactly ${missingMonths} missing month(s)`);
    }
  }

  const chargeIds = new Set<string>();
  const chargeProvenance = new Set<string>();
  for (const charge of bundle.charges ?? []) {
    record(charge, 'charges');
    const id = text(charge.id, 'charges: id');
    const label = `charges ${id}`;
    unique(chargeIds, id, label);
    unique(chargeProvenance, provenance(charge.provenance, label), `${label}: provenance`);
    const month = text(charge.month, `${label}: month`);
    date(`${month}-01`, `${label}: month`);
    if (charge.currency !== currency) throw new Error(`${label}: currency must match bundle currency`);
    text(charge.category, `${label}: category`);
    if (typeof charge.amount !== 'number' || !Number.isFinite(charge.amount) || charge.amount < 0) {
      throw new Error(`${label}: amount must be finite and nonnegative`);
    }
    text(charge.billId, `${label}: billId`);
    text(charge.allocatedTo, `${label}: allocatedTo`);
    text(charge.allocationKey, `${label}: allocationKey`);
  }
  reconcileCharges(bundle);
  for (const source of ['tickets', 'commits', 'usage', 'charges'] as const) {
    const records = bundle[source];
    if (records && bundle.coverage.find(entry => entry.source === source)?.extracted !== records.length) {
      throw new Error(`${source}: coverage extracted must match records`);
    }
  }
  return bundle;
}