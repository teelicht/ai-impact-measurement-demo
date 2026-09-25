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

test("cached input is a subset of input, not an additional token charge", () => {
	const source = loadSynthetic();
	const summary = summarizeUsageAndCost({ ...source, usage: [detailedEvent] });
	const month = summary.monthly.find((row) => row.month === "2025-09");
	assert.equal(month?.tokens, 120);
	assert.equal(month?.inputTokens, 100);
	assert.equal(month?.cachedInputTokens, 40);
	assert.equal(month?.outputTokens, 20);
});

test("failed attempts and retries each count once in model and status breakdowns", () => {
	const source = loadSynthetic();
	const summary = summarizeUsageAndCost({
		...source,
		usage: [
			{ ...detailedEvent, outcome: "failed", attempt: 1 },
			{
				...detailedEvent,
				id: "retry",
				provenance: { source: "test", recordId: "retry" },
				model: "second-model",
				inputTokens: 50,
				cachedInputTokens: 10,
				outputTokens: 30,
				outcome: "success",
				attempt: 2,
			},
		],
	});
	const month = summary.monthly[0];
	assert.equal(month.tokens, 200);
	assert.deepEqual(month.attempts, { success: 1, failed: 1, retries: 1 });
	assert.ok(month.byModel);
	assert.deepEqual(month.byModel["example-model"], {
		inputTokens: 100,
		cachedInputTokens: 40,
		outputTokens: 20,
		tokens: 120,
		attempts: 1,
		failed: 1,
		retries: 0,
	});
	assert.equal(month.byModel["second-model"].tokens, 80);
	assert.deepEqual(month.workItemLinks, { linked: 2, unlinked: 0 });
});

test("M7 reconciles EUR billing categories and spend per approved parent without asserting ROI", () => {
	const summary = summarizeUsageAndCost(loadSynthetic());
	const march = summary.monthly.find((row) => row.month === "2026-03");
	assert.ok(march);
	assert.equal(march.tokens, 12_000_000);
	assert.equal(march.toolSpend, 120);
	assert.deepEqual(march.billingCategories, { subscription: 30, consumption: 90 });
	assert.equal(march.approvedParents, 24);
	assert.equal(march.toolSpendPerApprovedParent, 5);
	assert.equal(summary.currency, "EUR");
	assert.equal(summary.totalAiCost, null);
	assert.equal(summary.roi, null);
	assert.match(summary.financialGaps.join(" "), /human review|correction|enablement|governance|platform/i);
});

test("monthly rollups retain total tokens but have no inferred breakdown", () => {
	const source = loadSynthetic();
	const records = source.usage;
	assert.ok(records);
	const first = records[0];
	assert.ok(first);
	const summary = summarizeUsageAndCost(source);
	assert.equal(summary.monthly[6].tokens, 12_000_000);
	assert.equal(summary.monthly[6].inputTokens, null);
	assert.equal(summary.monthly[6].cachedInputTokens, null);
	assert.equal(summary.monthly[6].outputTokens, null);
	assert.equal(summary.monthly[6].byModel, null);
	assert.equal(summary.monthly[6].attempts, null);
	assert.equal(summary.monthly[6].workItemLinks, null);
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [...records, detailedEvent] }), /mixed usage modes/i);
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [...records, { ...first, id: "another-id" }] }), /duplicate month/i);
});

test("a missing month in partial monthly usage is unavailable, not zero", () => {
	const source = loadSynthetic();
	const records = source.usage;
	assert.ok(records);
	const summary = summarizeUsageAndCost({
		...source,
		usage: records.slice(1),
		coverage: source.coverage.map((entry) =>
			entry.source === "usage" ? { ...entry, status: "partial", extracted: 11, missing: 1, reason: "September token total not supplied." } : entry,
		),
	});
	assert.equal(summary.monthly[0].tokens, null);
	assert.equal(summary.monthly[0].measureStatus.tokens, "partial");
	assert.equal(summary.monthly[1].tokens, 9_000_000);
});

test("direct monthly accounting rejects out-of-window rollups and empty exports remain unknown", () => {
	const source = loadSynthetic();
	const records = source.usage;
	assert.ok(records);
	const first = records[0];
	assert.ok(first && isMonthlyUsage(first));
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [{ ...first, month: "2024-09" }, ...records.slice(1)] }), /outside|window/i);
	const empty = summarizeUsageAndCost({ ...source, usage: [] });
	assert.equal(empty.monthly[0].tokens, null);
	assert.equal(empty.monthly[0].measureStatus.tokens, "partial");
});

test("unavailable or partial sources cannot become a zero or complete cost ratio", () => {
	const source = loadSynthetic();
	const summary = summarizeUsageAndCost({
		...source,
		usage: undefined,
		charges: undefined,
		coverage: source.coverage.map((entry) =>
			entry.source === "usage" || entry.source === "charges" ? { ...entry, status: "unavailable" as const, extracted: 0, linked: 0, reason: "Not supplied." } : entry,
		),
	});
	assert.equal(summary.monthly[0].tokens, null);
	assert.equal(summary.monthly[0].attempts, null);
	assert.equal(summary.monthly[0].workItemLinks, null);
	assert.equal(summary.monthly[0].byModel, null);
	assert.equal(summary.monthly[0].toolSpend, null);
	assert.equal(summary.monthly[0].toolSpendPerApprovedParent, null);
	const partial = summarizeUsageAndCost({
		...source,
		coverage: source.coverage.map((entry) => (entry.source === "tickets" ? { ...entry, status: "partial" as const, reason: "Missing tickets." } : entry)),
	});
	assert.equal(partial.monthly[6].toolSpend, 120);
	assert.equal(partial.monthly[6].toolSpendPerApprovedParent, null);
});

test("rejects duplicate usage IDs, monthly allocations, and conflicting charge currencies", () => {
	const source = loadSynthetic();
	const event = source.usage?.[0];
	const charge = source.charges?.[0];
	assert.ok(event);
	assert.ok(charge);
	assert.throws(() => summarizeUsageAndCost({ ...source, usage: [event, event] }), /usage .*duplicate/i);
	assert.throws(
		() => summarizeUsageAndCost({ ...source, charges: [charge, { ...charge, id: "another", provenance: { source: "test", recordId: "another" } }] }),
		/allocationKey|allocation/i,
	);
	assert.throws(() => summarizeUsageAndCost({ ...source, charges: [{ ...charge, currency: "USD" }] }), /currency/i);
});

test("different allocation keys cannot charge more than their shared bill total", () => {
	const source = loadSynthetic();
	const charge = source.charges?.[0];
	assert.ok(charge);
	const first = { ...charge, billId: "shared-bill", billTotal: 100, amount: 60 };
	const second = { ...first, id: "second-allocation", provenance: { source: "test", recordId: "second-allocation" }, allocationKey: "other-team", amount: 60 };
	assert.throws(() => summarizeUsageAndCost({ ...source, charges: [first, second] }), /shared-bill.*(total|allocat)/i);
});

test("a valid shared bill counts only this team allocations once", () => {
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
});

test("direct summaries reject partial March windows with a whole-month charge", () => {
	const source = loadSynthetic();
	const charge = source.charges?.find((entry) => entry.month === "2026-03");
	assert.ok(charge);
	for (const [startDate, endDate] of [
		["2026-03-15", "2026-03-31"],
		["2026-03-01", "2026-03-30"],
	]) {
		assert.throws(() => summarizeUsageAndCost({ ...source, startDate, endDate, charges: [charge] }), /full month/i);
	}
});

test("direct summaries expose gaps and incomplete status for partial and empty sources", () => {
	const source = loadSynthetic();
	const partial = summarizeUsageAndCost({
		...source,
		usage: [],
		charges: [],
		coverage: source.coverage.map((entry) =>
			entry.source === "usage" || entry.source === "charges" ? { ...entry, status: "partial" as const, reason: "Import incomplete." } : entry,
		),
	});
	assert.equal(partial.monthly[0].measureStatus.tokens, "partial");
	assert.equal(partial.monthly[0].measureStatus.toolSpend, "partial");
	assert.match(partial.evidenceGaps.map((gap) => gap.reason).join(" "), /usage|billing|charges/i);

	const empty = summarizeUsageAndCost({ ...source, usage: [], charges: [] });
	assert.equal(empty.monthly[0].measureStatus.tokens, "partial");
	assert.equal(empty.monthly[0].measureStatus.toolSpend, "partial");
	assert.match(empty.evidenceGaps.map((gap) => gap.reason).join(" "), /empty|no records/i);
});

test("model and billing labels named like object prototype properties remain ordinary data", () => {
	const source = loadSynthetic();
	const charge = source.charges?.[0];
	assert.ok(charge);
	const month = summarizeUsageAndCost({ ...source, usage: [{ ...detailedEvent, model: "__proto__" }], charges: [{ ...charge, category: "__proto__", amount: 20 }] }).monthly[0];
	const reservedLabel = "__proto__";
	assert.equal(month.byModel?.[reservedLabel].tokens, 120);
	assert.equal(month.billingCategories?.[reservedLabel], 20);
	assert.equal(({} as Record<string, unknown>).tokens, undefined);
});

const migration = JSON.parse(readFileSync(new URL("../../data/migration.json", import.meta.url), "utf8")) as FinancialCase;

test("verified USD migration ledger yields 15000 net benefit and 75 percent ROI for 12 weeks", () => {
	const result = evaluateFinancialCase(migration);
	assert.equal(result.currency, "USD");
	assert.equal(result.period, "12 weeks");
	assert.deepEqual([result.realizedValue, result.avoidedCost, result.totalCost], [0, 35_000, 20_000]);
	assert.equal(result.netBenefit, 15_000);
	assert.equal(result.roi, 0.75);
	assert.deepEqual(result.excludedClaims, ["MIG-DUP-01"]);
	assert.deepEqual(result.gaps, []);
});

test("duplicate benefit IDs, verified overlapping benefits, or unapproved cancellation block ROI", () => {
	const duplicate = { ...migration, claims: [...migration.claims, { ...migration.claims[0], category: "realized-value" as const, amount: 2400 }] };
	assert.equal(evaluateFinancialCase(duplicate).roi, null);
	assert.match(evaluateFinancialCase(duplicate).gaps.join(" "), /duplicate.*MIG-01/i);
	const overlap = { ...migration, claims: migration.claims.map((claim) => (claim.id === "MIG-DUP-01" ? { ...claim, verificationStatus: "verified" as const } : claim)) };
	assert.equal(evaluateFinancialCase(overlap).netBenefit, null);
	assert.match(evaluateFinancialCase(overlap).gaps.join(" "), /overlap/i);
	const cancellation = { ...migration, claims: migration.claims.map((claim) => (claim.id === "MIG-01" ? { ...claim, cancellationApproved: false } : claim)) };
	assert.equal(evaluateFinancialCase(cancellation).roi, null);
	assert.match(evaluateFinancialCase(cancellation).gaps.join(" "), /cancellation/i);
	const scope = { ...migration, claims: migration.claims.map((claim) => (claim.id === "MIG-01" ? { ...claim, scopeAccepted: false } : claim)) };
	assert.equal(evaluateFinancialCase(scope).roi, null);
	assert.match(evaluateFinancialCase(scope).gaps.join(" "), /scope/i);
});

test("distinct IDs cannot double-claim the same verified source allocation", () => {
	const duplicateCost = { ...migration, claims: [...migration.claims, { ...migration.claims[1], id: "MIG-COST-COPY" }] };
	const result = evaluateFinancialCase(duplicateCost);
	assert.equal(result.netBenefit, null);
	assert.equal(result.roi, null);
	assert.match(result.gaps.join(" "), /duplicate.*allocation/i);
});

test("conflicting currency or period and incomplete or unverified costs block both financial results", () => {
	for (const caseData of [
		{ ...migration, claims: migration.claims.map((claim) => (claim.id === "MIG-COST-01" ? { ...claim, currency: "EUR" } : claim)) },
		{ ...migration, claims: migration.claims.map((claim) => (claim.id === "MIG-COST-01" ? { ...claim, period: "6 weeks" } : claim)) },
		{ ...migration, totalIncrementalCostComplete: false },
		{ ...migration, claims: migration.claims.map((claim) => (claim.id === "MIG-COST-01" ? { ...claim, verificationStatus: "unverified" as const } : claim)) },
	]) {
		const result = evaluateFinancialCase(caseData);
		assert.equal(result.netBenefit, null);
		assert.equal(result.roi, null);
		assert.ok(result.gaps.length > 0);
	}
});
