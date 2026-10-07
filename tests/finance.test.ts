import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { evaluateFinancialCase, type FinancialCase, summarizeUsageAndCost } from "../src/finance.js";
import type { UsageEvent } from "../src/model.js";
import { isMonthlyUsage } from "../src/model.js";

const detailedEvent: UsageEvent = {
	id: "use-1",
	provenance: { source: "test", recordId: "use-1" },
	at: "2025-09-18T10:00:00Z",
	model: "example-model",
	inputTokens: 100,
	cachedInputTokens: 40,
	outputTokens: 20,
	attempt: 1,
	outcome: "success",
	ticketId: "API-1000",
};

test("event usage counts cached input as part of input and each attempt once", () => {
	const source = loadSynthetic();
	const retry = {
		...detailedEvent,
		id: "retry",
		provenance: { source: "test", recordId: "retry" },
		model: "second-model",
		inputTokens: 50,
		cachedInputTokens: 10,
		outputTokens: 30,
		attempt: 2,
	};
	const month = summarizeUsageAndCost({ ...source, usage: [{ ...detailedEvent, outcome: "failed" }, retry] }).monthly[0];
	assert.equal(month.tokens, 200);
	assert.deepEqual([month.inputTokens, month.cachedInputTokens, month.outputTokens], [150, 50, 50]);
	assert.deepEqual(month.attempts, { success: 1, failed: 1, retries: 1 });
	assert.deepEqual(month.byModel?.["example-model"], { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, tokens: 120, attempts: 1, failed: 1, retries: 0 });
	assert.deepEqual(month.workItemLinks, { linked: 2, unlinked: 0 });
});

test("monthly rollups keep totals without an inferred breakdown and reject mixed or duplicate records", () => {
	const source = loadSynthetic();
	const records = source.usage ?? [];
	const march = summarizeUsageAndCost(source).monthly[6];
	assert.equal(march.tokens, 70_000_000);
	assert.equal(march.toolSpend, 360);
	assert.deepEqual(march.billingCategories, { subscription: 210, consumption: 150 });
	assert.equal(march.toolSpendPerApprovedParent, 15);
	for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "byModel", "attempts", "workItemLinks"] as const) assert.equal(march[key], null, key);
	const first = records[0];
	assert.ok(first && isMonthlyUsage(first));
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [...records, detailedEvent] }));
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [...records, { ...first, id: "another-id" }] }));
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [{ ...first, month: "2024-09" }, ...records.slice(1)] }));
});

test("rejects duplicate usage IDs, double allocations, over-allocated bills and conflicting currencies", () => {
	const source = loadSynthetic();
	const event = source.usage?.[0];
	const charge = source.charges?.[0];
	assert.ok(event && charge);
	const shared = { ...charge, billId: "shared-bill", billTotal: 100, amount: 60 };
	for (const change of [
		{ usage: [event, event] },
		{ charges: [charge, { ...charge, id: "another", provenance: { source: "test", recordId: "another" } }] },
		{ charges: [shared, { ...shared, id: "second", provenance: { source: "test", recordId: "second" }, allocationKey: "other-team" }] },
		{ charges: [{ ...charge, currency: "USD" }] },
	]) {
		assert.throws(() => summarizeUsageAndCost({ ...source, ...change }));
	}
});

test("missing, partial or empty sources stay unknown rather than zero", () => {
	const source = loadSynthetic();
	const records = source.usage ?? [];
	const gap = summarizeUsageAndCost({
		...source,
		usage: records.slice(1),
		coverage: source.coverage.map((entry) => (entry.source === "usage" ? { ...entry, status: "partial", extracted: 11, missing: 1, reason: "September missing." } : entry)),
	});
	assert.equal(gap.monthly[0].tokens, null);
	assert.equal(gap.monthly[0].measureStatus.tokens, "partial");
	assert.equal(gap.monthly[1].tokens, 50_000_000);

	const absent = summarizeUsageAndCost({
		...source,
		usage: undefined,
		charges: undefined,
		coverage: source.coverage.map((entry) =>
			entry.source === "usage" || entry.source === "charges" ? { ...entry, status: "unavailable" as const, extracted: 0, linked: 0, reason: "Not supplied." } : entry,
		),
	});
	assert.equal(absent.monthly[0].tokens, null);
	assert.equal(absent.monthly[0].toolSpendPerApprovedParent, null);

	const partialTickets = summarizeUsageAndCost({
		...source,
		coverage: source.coverage.map((entry) => (entry.source === "tickets" ? { ...entry, status: "partial" as const, reason: "Missing tickets." } : entry)),
	});
	assert.equal(partialTickets.monthly[6].toolSpend, 360);
	assert.equal(partialTickets.monthly[6].toolSpendPerApprovedParent, null);

	const empty = summarizeUsageAndCost({ ...source, usage: [], charges: [] });
	assert.equal(empty.monthly[0].measureStatus.tokens, "partial");
	assert.equal(empty.monthly[0].measureStatus.toolSpend, "partial");
	assert.ok(empty.evidenceGaps.length > 0);
	assert.equal(summarizeUsageAndCost(source).totalAiCost, null);
});

test("shared bills count only this team's allocations and partial-month windows are rejected", () => {
	const source = loadSynthetic();
	const charge = source.charges?.[0];
	assert.ok(charge);
	const bill = { ...charge, billId: "shared-bill", billTotal: 100, amount: 25 };
	const charges = [
		bill,
		{ ...bill, id: "second-team-charge", provenance: { source: "test", recordId: "second-team-charge" }, allocationKey: "team-extra", amount: 15 },
		{ ...bill, id: "other-team-charge", provenance: { source: "test", recordId: "other-team-charge" }, allocatedTo: "Other team", allocationKey: "other-team", amount: 60 },
	];
	const month = summarizeUsageAndCost({ ...source, charges }).monthly[0];
	assert.equal(month.toolSpend, 40);
	assert.deepEqual(month.billingCategories, { subscription: 40 });
	const march = source.charges?.find((entry) => entry.month === "2026-03");
	assert.ok(march);
	for (const [startDate, endDate] of [
		["2026-03-15", "2026-03-31"],
		["2026-03-01", "2026-03-30"],
	]) {
		assert.throws(() => summarizeUsageAndCost({ ...source, startDate, endDate, charges: [march] }));
	}
});

test("prototype-like model and billing labels remain ordinary data", () => {
	const source = loadSynthetic();
	const charge = source.charges?.[0];
	assert.ok(charge);
	const month = summarizeUsageAndCost({ ...source, usage: [{ ...detailedEvent, model: "__proto__" }], charges: [{ ...charge, category: "__proto__", amount: 20 }] }).monthly[0];
	const reserved = "__proto__";
	assert.equal(month.byModel?.[reserved].tokens, 120);
	assert.equal(month.billingCategories?.[reserved], 20);
	assert.equal(({} as Record<string, unknown>).tokens, undefined);
});

const migration = JSON.parse(readFileSync(new URL("../../data/migration.json", import.meta.url), "utf8")) as FinancialCase;

test("verified migration ledger yields net benefit and ROI and excludes overlapping claims", () => {
	const result = evaluateFinancialCase(migration);
	assert.deepEqual([result.currency, result.period], ["USD", "12 weeks"]);
	assert.deepEqual([result.realizedValue, result.avoidedCost, result.totalCost, result.netBenefit, result.roi], [0, 35_000, 20_000, 15_000, 0.75]);
	assert.deepEqual(result.excludedClaims, ["MIG-DUP-01"]);
	assert.deepEqual(result.gaps, []);
});

test("any unverifiable or double-counted claim blocks net benefit and ROI", () => {
	const change = (id: string, patch: object) => ({ ...migration, claims: migration.claims.map((claim) => (claim.id === id ? { ...claim, ...patch } : claim)) });
	for (const caseData of [
		{ ...migration, claims: [...migration.claims, { ...migration.claims[0], category: "realized-value" as const, amount: 2400 }] },
		{ ...migration, claims: [...migration.claims, { ...migration.claims[1], id: "MIG-COST-COPY" }] },
		change("MIG-DUP-01", { verificationStatus: "verified" }),
		change("MIG-01", { cancellationApproved: false }),
		change("MIG-01", { scopeAccepted: false }),
		change("MIG-COST-01", { currency: "EUR" }),
		change("MIG-COST-01", { period: "6 weeks" }),
		change("MIG-COST-01", { verificationStatus: "unverified" }),
		{ ...migration, totalIncrementalCostComplete: false },
	]) {
		const result = evaluateFinancialCase(caseData as FinancialCase);
		assert.equal(result.netBenefit, null);
		assert.equal(result.roi, null);
		assert.ok(result.gaps.length > 0);
	}
});
