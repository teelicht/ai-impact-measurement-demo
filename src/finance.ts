import { isMonthlyUsage, type Charge, type Coverage, type SourceBundle } from './model.js';

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  tokens: number;
  attempts: number;
  failed: number;
  retries: number;
}

export interface UsageCostMonth {
  month: string;
  measureStatus: Record<'tokens' | 'toolSpend' | 'approvedParents' | 'toolSpendPerApprovedParent', Coverage['status']>;
  tokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  byModel: Record<string, ModelUsage> | null;
  attempts: { success: number; failed: number; retries: number } | null;
  workItemLinks: { linked: number; unlinked: number } | null;
  billingCategories: Record<string, number> | null;
  toolSpend: number | null;
  approvedParents: number | null;
  toolSpendPerApprovedParent: number | null;
}

export interface UsageCostSummary {
  currency: string;
  monthly: UsageCostMonth[];
  evidenceGaps: { metric: string; reason: string }[];
  totalAiCost: null;
  netBenefit: null;
  roi: null;
  financialGaps: string[];
}

function localDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function reportingMonths(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  while (`${year}-${String(month).padStart(2, '0')}` <= endDate.slice(0, 7)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    if (++month === 13) { year++; month = 1; }
  }
  return months;
}

function addTokens(current: number | null, amount: number): number {
  const total = (current ?? 0) + amount;
  if (!Number.isSafeInteger(total)) throw new Error('usage: token total exceeds safe integer precision');
  return total;
}

export function reconcileCharges(bundle: SourceBundle): Charge[] {
  const allocations = new Set<string>();
  const chargeIds = new Set<string>();
  const bills = new Map<string, { total: number; allocated: number; currency: string }>();
  for (const charge of bundle.charges ?? []) {
    if (charge.currency !== bundle.currency) {
      throw new Error(`charges ${charge.id}: currency must match bundle currency ${bundle.currency}`);
    }
    if (!charge.id?.trim() || chargeIds.has(charge.id)) {
      throw new Error(`charges ${charge.id}: missing or duplicate charge ID`);
    }
    chargeIds.add(charge.id);
    if (!charge.billId?.trim() || !Number.isFinite(charge.billTotal) || charge.billTotal < 0 ||
        !charge.allocatedTo?.trim() || !charge.allocationKey?.trim() ||
        !Number.isFinite(charge.amount) || charge.amount < 0) {
      throw new Error(`charges ${charge.id}: billId, billTotal, allocatedTo, allocationKey and amount must be valid`);
    }
    const allocation = JSON.stringify([charge.billId, charge.allocationKey]);
    if (allocations.has(allocation)) {
      throw new Error(`charges ${charge.id}: duplicate allocationKey ${charge.allocationKey} for bill ${charge.billId}`);
    }
    allocations.add(allocation);
    const bill = bills.get(charge.billId);
    if (bill && (bill.total !== charge.billTotal || bill.currency !== charge.currency)) {
      throw new Error(`charges ${charge.id}: inconsistent bill ${charge.billId} metadata`);
    }
    const allocated = (bill?.allocated ?? 0) + charge.amount;
    if (allocated > charge.billTotal + Number.EPSILON * Math.max(1, charge.billTotal) * 4) {
      throw new Error(`charges ${charge.id}: bill ${charge.billId} allocations exceed bill total`);
    }
    bills.set(charge.billId, { total: charge.billTotal, allocated, currency: charge.currency });
  }
  return (bundle.charges ?? []).filter(charge => charge.allocatedTo === bundle.scope);
}

export function summarizeUsageAndCost(bundle: SourceBundle): UsageCostSummary {
  if (!bundle.startDate.endsWith('-01')) {
    throw new Error('bundle: startDate must be the first day of a full month');
  }
  const lastDay = new Date(`${bundle.endDate.slice(0, 7)}-01T00:00:00Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  if (bundle.endDate !== lastDay.toISOString().slice(0, 10)) {
    throw new Error('bundle: endDate must be the last day of a full month');
  }
  const usageIds = new Set<string>();
  const rollupMonths = new Set<string>();
  const hasRollups = bundle.usage?.some(isMonthlyUsage) ?? false;
  for (const event of bundle.usage ?? []) {
    if (usageIds.has(event.id)) throw new Error(`usage ${event.id}: duplicate event ID`);
    usageIds.add(event.id);
    if (isMonthlyUsage(event)) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.month) ||
          !Number.isSafeInteger(event.tokens) || event.tokens < 0) {
        throw new Error(`usage ${event.id}: invalid monthly tokens or month`);
      }
      if (event.month < bundle.startDate.slice(0, 7) || event.month > bundle.endDate.slice(0, 7)) {
        throw new Error(`usage ${event.id}: month outside reporting window`);
      }
      if (rollupMonths.has(event.month)) throw new Error(`usage ${event.id}: duplicate month`);
      rollupMonths.add(event.month);
      continue;
    }
    if (hasRollups) throw new Error(`usage ${event.id}: mixed usage modes are not supported`);
    if (!Number.isSafeInteger(event.inputTokens) || event.inputTokens < 0 ||
        !Number.isSafeInteger(event.outputTokens) || event.outputTokens < 0 ||
        !Number.isSafeInteger(event.cachedInputTokens) || event.cachedInputTokens < 0 ||
        event.cachedInputTokens > event.inputTokens || !Number.isSafeInteger(event.attempt) || event.attempt < 1 ||
        !['success', 'failed'].includes(event.outcome)) {
      throw new Error(`usage ${event.id}: invalid token categories, attempt or outcome`);
    }
  }
  if (hasRollups) {
    const expectedMonths = reportingMonths(bundle.startDate, bundle.endDate).length;
    const missingMonths = expectedMonths - rollupMonths.size;
    const coverage = bundle.coverage.find(entry => entry.source === 'usage');
    if (coverage?.missing !== missingMonths || coverage.eligible !== expectedMonths ||
        coverage.linked !== 0 || coverage.excluded !== 0 ||
        (coverage.status === 'available' && missingMonths > 0)) {
      throw new Error(`usage: ${missingMonths} missing month(s) require partial coverage`);
    }
  }
  const teamCharges = reconcileCharges(bundle);
  const hasDetailedUsage = bundle.usage !== undefined && bundle.usage.length > 0 && !hasRollups;

  const sourceStatus = (source: 'usage' | 'charges' | 'tickets'): Coverage['status'] => {
    const declared = bundle.coverage.find(entry => entry.source === source)?.status ?? 'unavailable';
    if (declared === 'unavailable') return declared;
    return bundle[source]?.length ? declared : 'partial';
  };
  const evidenceGaps = (['usage', 'charges', 'tickets'] as const).flatMap(source => {
    const status = sourceStatus(source);
    if (status === 'available') return [];
    const reason = bundle[source]?.length === 0 ? 'No records in the source export; verify completeness.'
      : bundle.coverage.find(entry => entry.source === source)?.reason || 'Source records unavailable.';
    return [{ metric: source, reason: `${source}: ${reason}` }];
  });
  const monthly = reportingMonths(bundle.startDate, bundle.endDate).map(month => ({
    month,
    measureStatus: { tokens: sourceStatus('usage'), toolSpend: sourceStatus('charges'),
      approvedParents: sourceStatus('tickets'),
      toolSpendPerApprovedParent: sourceStatus('tickets') === 'unavailable' ||
        sourceStatus('charges') === 'unavailable' ? 'unavailable' as const :
        sourceStatus('tickets') === 'partial' || sourceStatus('charges') === 'partial'
          ? 'partial' as const : 'available' as const },
    tokens: hasDetailedUsage ? 0 : null,
    inputTokens: hasDetailedUsage ? 0 : null,
    cachedInputTokens: hasDetailedUsage ? 0 : null,
    outputTokens: hasDetailedUsage ? 0 : null,
    byModel: hasDetailedUsage ? Object.create(null) as Record<string, ModelUsage> : null,
    attempts: hasDetailedUsage ? { success: 0, failed: 0, retries: 0 } : null,
    workItemLinks: hasDetailedUsage ? { linked: 0, unlinked: 0 } : null,
    billingCategories: bundle.charges === undefined ? null : Object.create(null) as Record<string, number>,
    toolSpend: bundle.charges === undefined ? null : 0,
    approvedParents: bundle.tickets === undefined ? null : 0,
    toolSpendPerApprovedParent: null as number | null,
  }));
  const byMonth = new Map(monthly.map(row => [row.month, row]));
  const knownTickets = new Set((bundle.tickets ?? []).map(ticket => ticket.id));
  for (const event of bundle.usage ?? []) {
    if (isMonthlyUsage(event)) {
      const row = byMonth.get(event.month);
      if (row) row.tokens = addTokens(row.tokens, event.tokens);
      continue;
    }
    const date = localDate(event.at, bundle.timezone);
    if (date < bundle.startDate || date > bundle.endDate) continue;
    const row = byMonth.get(date.slice(0, 7));
    if (!row?.byModel || !row.attempts || !row.workItemLinks) continue;
    row.inputTokens = (row.inputTokens ?? 0) + event.inputTokens;
    row.cachedInputTokens = (row.cachedInputTokens ?? 0) + event.cachedInputTokens;
    row.outputTokens = (row.outputTokens ?? 0) + event.outputTokens;
    row.tokens = addTokens(row.tokens, event.inputTokens + event.outputTokens);
    const model = row.byModel[event.model] ?? {
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokens: 0,
      attempts: 0, failed: 0, retries: 0,
    };
    model.inputTokens += event.inputTokens;
    model.cachedInputTokens += event.cachedInputTokens;
    model.outputTokens += event.outputTokens;
    model.tokens += event.inputTokens + event.outputTokens;
    model.attempts++;
    if (event.outcome === 'failed') model.failed++;
    if (event.attempt > 1) { model.retries++; row.attempts.retries++; }
    row.attempts[event.outcome]++;
    row.workItemLinks[event.ticketId && knownTickets.has(event.ticketId) ? 'linked' : 'unlinked']++;
    row.byModel[event.model] = model;
  }
  for (const charge of teamCharges) {
    const row = byMonth.get(charge.month);
    if (!row || row.billingCategories === null) continue;
    row.billingCategories[charge.category] = (row.billingCategories[charge.category] ?? 0) + charge.amount;
    row.toolSpend = (row.toolSpend ?? 0) + charge.amount;
  }
  for (const ticket of bundle.tickets ?? []) {
    if (ticket.parentId || ticket.emergency || !['Story', 'Task'].includes(ticket.type) ||
        ticket.status !== 'approved' || ticket.approvals.length === 0) continue;
    const first = ticket.approvals.reduce((earliest, approval) =>
      Date.parse(approval.at) < Date.parse(earliest) ? approval.at : earliest, ticket.approvals[0].at);
    const date = localDate(first, bundle.timezone);
    if (date < bundle.startDate || date > bundle.endDate) continue;
    const row = byMonth.get(date.slice(0, 7));
    if (row) row.approvedParents = (row.approvedParents ?? 0) + 1;
  }
  for (const row of monthly) {
    if (row.measureStatus.toolSpendPerApprovedParent === 'available' &&
        row.approvedParents !== null && row.approvedParents > 0 && row.toolSpend !== null) {
      row.toolSpendPerApprovedParent = row.toolSpend / row.approvedParents;
    }
    if (row.byModel !== null) row.byModel = Object.fromEntries(Object.entries(row.byModel));
    if (row.billingCategories !== null) {
      row.billingCategories = Object.fromEntries(Object.entries(row.billingCategories));
    }
  }
  return {
    currency: bundle.currency, monthly, evidenceGaps, totalAiCost: null, netBenefit: null, roi: null,
    financialGaps: [
      'Recorded tool spend excludes unpriced human review, correction, enablement, governance and platform costs; total AI cost and API-team ROI are unassessed.',
    ],
  };
}

export interface FinancialClaim {
  id: string;
  category: 'realized-value' | 'avoided-cost' | 'cost' | 'overlapping-benefit';
  amount: number;
  verificationStatus: 'verified' | 'excluded' | 'unverified';
  supportingSource: string;
  verifierRole: string;
  allocationBasis: string;
  currency?: string;
  period?: string;
  overlapsWith?: string;
  cancellationApproved?: boolean;
  scopeAccepted?: boolean;
}

export interface FinancialCase {
  currency: string;
  period: string;
  totalIncrementalCostComplete: boolean;
  claims: FinancialClaim[];
}

export interface FinancialResult {
  currency: string;
  period: string;
  realizedValue: number | null;
  avoidedCost: number | null;
  totalCost: number | null;
  netBenefit: number | null;
  roi: number | null;
  excludedClaims: string[];
  gaps: string[];
}

export function evaluateFinancialCase(caseData: FinancialCase): FinancialResult {
  const gaps: string[] = [];
  const excludedClaims: string[] = [];
  const seen = new Set<string>();
  const verifiedAllocations = new Set<string>();
  const claims = Array.isArray(caseData.claims) ? caseData.claims : [];
  if (!/^[A-Z]{3}$/.test(caseData.currency) || !caseData.period?.trim()) {
    gaps.push('Financial case requires one valid currency and evaluation period.');
  }
  if (caseData.totalIncrementalCostComplete !== true) {
    gaps.push('Complete material incremental costs have not been attested.');
  }
  if (claims.length === 0) gaps.push('No verified benefit and cost claims supplied.');
  let realizedValue = 0;
  let avoidedCost = 0;
  let totalCost = 0;
  for (const claim of claims) {
    if (!claim.id?.trim() || seen.has(claim.id)) {
      gaps.push(`Duplicate or missing claim ID ${claim.id ?? '(missing)'}.`);
    }
    seen.add(claim.id);
    if (claim.currency !== undefined && claim.currency !== caseData.currency) {
      gaps.push(`Claim ${claim.id}: currency differs from ${caseData.currency}.`);
    }
    if (claim.period !== undefined && claim.period !== caseData.period) {
      gaps.push(`Claim ${claim.id}: period differs from ${caseData.period}.`);
    }
    if (!Number.isFinite(claim.amount) || claim.amount < 0) {
      gaps.push(`Claim ${claim.id}: amount must be finite and nonnegative.`);
    }
    if (!claim.supportingSource?.trim() || !claim.verifierRole?.trim() || !claim.allocationBasis?.trim()) {
      gaps.push(`Claim ${claim.id}: supporting source, verifier and allocation basis are required.`);
    }
    if (claim.verificationStatus === 'excluded' && claim.category === 'overlapping-benefit' &&
        claim.overlapsWith && claims.some(other => other.id === claim.overlapsWith &&
          ['avoided-cost', 'realized-value'].includes(other.category))) {
      excludedClaims.push(claim.id);
      continue;
    }
    if (claim.verificationStatus !== 'verified') {
      gaps.push(`Claim ${claim.id}: unverified or unexplained exclusion cannot enter the financial result.`);
      continue;
    }
    const allocation = JSON.stringify([claim.supportingSource, claim.allocationBasis]);
    if (verifiedAllocations.has(allocation)) {
      gaps.push(`Claim ${claim.id}: duplicate verified source allocation.`);
    }
    verifiedAllocations.add(allocation);
    if (claim.overlapsWith || claim.category === 'overlapping-benefit') {
      gaps.push(`Claim ${claim.id}: overlapping benefit cannot be included.`);
      continue;
    }
    if (claim.category === 'avoided-cost') {
      if (claim.cancellationApproved !== true) gaps.push(`Claim ${claim.id}: approved cancellation required.`);
      if (claim.scopeAccepted !== true) gaps.push(`Claim ${claim.id}: accepted equivalent scope required.`);
      avoidedCost += claim.amount;
    } else if (claim.category === 'realized-value') {
      realizedValue += claim.amount;
    } else if (claim.category === 'cost') {
      totalCost += claim.amount;
    } else {
      gaps.push(`Claim ${claim.id}: unknown category.`);
    }
  }
  if (totalCost <= 0) gaps.push('Total verified incremental cost must be greater than zero for ROI.');
  if (gaps.length > 0) {
    return { currency: caseData.currency, period: caseData.period,
      realizedValue: null, avoidedCost: null, totalCost: null, netBenefit: null, roi: null,
      excludedClaims, gaps };
  }
  const netBenefit = realizedValue + avoidedCost - totalCost;
  return { currency: caseData.currency, period: caseData.period,
    realizedValue, avoidedCost, totalCost, netBenefit, roi: netBenefit / totalCost,
    excludedClaims, gaps };
}