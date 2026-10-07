import assert from "node:assert/strict";
import test from "node:test";
import type { MonthlyUsage, SourceBundle, Ticket, UsageEvent } from "../src/model.js";
import { validateBundle } from "../src/validate.js";

const usage: UsageEvent = {
	id: "usage-1",
	at: "2026-01-10T10:00:00Z",
	model: "example-model",
	inputTokens: 100,
	cachedInputTokens: 20,
	outputTokens: 30,
	attempt: 1,
	outcome: "success",
	ticketId: "API-1",
	provenance: { source: "usage-export", recordId: "usage-1" },
};

const ticket: Ticket = {
	id: "API-1",
	type: "Story",
	createdAt: "2026-01-02T08:00:00Z",
	startedAt: "2026-01-03T08:00:00Z",
	status: "approved",
	approvals: [{ at: "2026-01-10T10:00:00Z", releaseId: "R1" }],
	provenance: { source: "ticket-export", recordId: "API-1" },
};

const valid: SourceBundle = {
	scope: "API team",
	sourceKind: "synthetic",
	startDate: "2026-01-01",
	endDate: "2026-12-31",
	timezone: "Europe/Berlin",
	extractedAt: "2027-01-01T10:00:00Z",
	currency: "EUR",
	completenessAttestation: "Synthetic example with known source gaps",
	coverage: ["tickets", "commits", "usage", "charges"].map((source) => ({
		source,
		status: "available",
		eligible: 1,
		extracted: 1,
		linked: 1,
		excluded: 0,
		missing: 0,
		reason: "",
	})),
	tickets: [ticket],
	commits: [
		{
			hash: "abc123",
			parents: [],
			at: "2026-01-09T10:00:00Z",
			paths: ["src/index.ts"],
			bot: false,
			ticketIds: ["API-1"],
			provenance: { source: "commit-export", recordId: "abc123" },
		},
	],
	usage: [usage],
	charges: [
		{
			id: "charge-1",
			month: "2026-01",
			currency: "EUR",
			category: "subscription",
			billId: "bill-1",
			billTotal: 75,
			allocatedTo: "API team",
			amount: 75,
			allocationKey: "team-seat",
			provenance: { source: "billing-export", recordId: "charge-1" },
		},
	],
};

const charge = valid.charges![0];
const commit = valid.commits![0];
const withCoverage = (source: string, change: object): SourceBundle["coverage"] => valid.coverage.map((entry) => (entry.source === source ? { ...entry, ...change } : entry));
const twoCharges = { ...valid, coverage: withCoverage("charges", { eligible: 2, extracted: 2 }) };
const sharedBill = [
	{ ...charge, billTotal: 100, amount: 40 },
	{ ...charge, id: "charge-2", provenance: { source: "billing-export", recordId: "charge-2" }, allocationKey: "other-team", allocatedTo: "Other team", billTotal: 100, amount: 60 },
];

const monthlyUsage: MonthlyUsage[] = Array.from({ length: 12 }, (_, index) => {
	const month = `2026-${String(index + 1).padStart(2, "0")}`;
	return { kind: "monthly-total", id: month, month, tokens: (index + 1) * 1_000_000, provenance: { source: "monthly-usage-export", recordId: month } };
});
const rollup = (records: SourceBundle["usage"] = monthlyUsage, change: object = {}): SourceBundle => ({
	...valid,
	usage: records,
	coverage: withCoverage("usage", { eligible: records?.length ?? 0, extracted: records?.length ?? 0, linked: 0, ...change }),
});

test("accepts valid bundles and supported variants unchanged", () => {
	const unavailable = {
		...valid,
		usage: undefined,
		charges: undefined,
		coverage: valid.coverage.map((entry) =>
			entry.source === "usage" || entry.source === "charges" ? { ...entry, status: "unavailable" as const, eligible: 0, extracted: 0, linked: 0, reason: "No export" } : entry,
		),
	};
	const sameProvenanceAcrossSources = structuredClone(valid);
	sameProvenanceAcrossSources.usage![0].provenance = { ...ticket.provenance };
	const configured = { ...valid, sourceKind: "configured" as const };
	const variants: SourceBundle[] = [
		valid,
		{ ...valid, context: { owner: "Engineering lead", updatedAt: "2026-09-02", repositories: ["Synthetic API commit history"], question: "What changed?" } },
		rollup(),
		configured,
		{ ...configured, startDate: "2028-02-01", endDate: "2028-02-29" },
		sameProvenanceAcrossSources,
		unavailable,
		{ ...valid, tickets: [{ ...ticket, status: "open", approvals: [] }] },
		{ ...valid, tickets: [{ ...ticket, status: "unknown", approvals: [] }] },
		...[true, false, undefined].map((production) => ({ ...valid, tickets: [{ ...ticket, type: "Bug", production }] })),
		{ ...valid, commits: [{ ...commit, linesAdded: 12, linesDeleted: 4, contributorId: "person-1", changeSize: 16 }] },
		{ ...twoCharges, charges: [charge, { ...charge, id: "charge-2", provenance: { ...charge.provenance, recordId: "charge-2" }, billId: "bill-2", month: "2026-02" }] },
		{ ...twoCharges, charges: sharedBill },
		{ ...twoCharges, charges: [sharedBill[0], { ...sharedBill[1], month: "2026-02", category: "consumption" }] },
		{ ...valid, coverage: withCoverage("usage", { status: "partial", eligible: 2, linked: 0, missing: 1, reason: "One event not exported" }) },
	];
	for (const bundle of variants) assert.strictEqual(validateBundle(bundle), bundle, JSON.stringify(bundle).slice(0, 200));
});

test("rejects invalid records and metadata, naming the record and field", () => {
	const cases: [SourceBundle, RegExp][] = [
		[{ ...valid, sourceKind: "live" as SourceBundle["sourceKind"] }, /bundle: sourceKind/],
		[{ ...valid, startDate: "2026-02-30" }, /bundle: startDate/],
		[{ ...valid, endDate: "2025-12-31" }, /bundle:.*endDate/],
		[{ ...valid, timezone: "Not/AZone" }, /bundle: timezone/],
		[{ ...valid, extractedAt: "yesterday" }, /bundle: extractedAt/],
		[{ ...valid, sourceKind: "configured", startDate: "2026-01-02" }, /startDate/],
		[{ ...valid, sourceKind: "configured", endDate: "2026-12-30" }, /endDate/],
		[{ ...valid, usage: [{ ...usage, cachedInputTokens: 101 }] }, /usage usage-1: cachedInputTokens/],
		[{ ...valid, usage: [{ ...usage, outcome: "pending" } as unknown as UsageEvent] }, /usage usage-1: outcome/],
		[{ ...valid, usage: [usage, { ...usage }] }, /usage usage-1: duplicate/],
		[{ ...valid, tickets: [{ ...ticket, createdAt: "2026-02-30T08:00:00Z" }] }, /tickets API-1: createdAt/],
		[{ ...valid, tickets: [{ ...ticket, status: "pending" } as unknown as Ticket] }, /tickets API-1: status/],
		[{ ...valid, tickets: [{ ...ticket, status: "open" }] }, /tickets API-1: status/],
		[{ ...valid, tickets: [{ ...ticket, approvals: [] }] }, /tickets API-1: status/],
		[{ ...valid, tickets: [{ ...ticket, type: "Bug", production: "yes" } as unknown as Ticket] }, /tickets API-1: production/],
		[{ ...valid, tickets: [{ ...ticket, parentId: "API-missing" }] }, /tickets API-1: parentId/],
		[{ ...valid, tickets: [{ ...ticket, approvals: [{ at: "2026-01-01T10:00:00Z", releaseId: "R1" }] }] }, /tickets API-1: approvals/],
		...(["linesAdded", "linesDeleted", "changeSize"] as const).map((field): [SourceBundle, RegExp] => [
			{ ...valid, commits: [{ ...commit, [field]: 1.5 }] },
			new RegExp(`commits abc123: ${field}`),
		]),
		[{ ...valid, commits: [{ ...commit, contributorId: " " }] }, /commits abc123: contributorId/],
		[{ ...valid, charges: [{ ...charge, currency: "USD" }] }, /charges charge-1: currency/],
		[{ ...twoCharges, charges: [charge, { ...charge, id: "charge-2", provenance: { ...charge.provenance, recordId: "charge-2" } }] }, /charges charge-2:.*allocationKey/],
		[{ ...twoCharges, charges: [sharedBill[0], { ...sharedBill[1], amount: 61 }] }, /bill-1/],
		[{ ...twoCharges, charges: [sharedBill[0], { ...sharedBill[1], billTotal: 101 }] }, /bill-1/],
		[{ ...valid, charges: [{ ...charge, billId: "" }] }, /billId/],
	];
	for (const [bundle, pattern] of cases) assert.throws(() => validateBundle(bundle), pattern, String(pattern));
	const missing = structuredClone(valid);
	delete (missing.tickets![0] as Partial<Ticket>).status;
	delete (missing.usage![0] as Partial<UsageEvent>).outcome;
	assert.throws(() => validateBundle(missing), /tickets API-1: status|usage usage-1: outcome/);
});

test("rejects report context that is blank, malformed or leaks locations and identities", () => {
	for (const context of [
		{ owner: "  " },
		{ updatedAt: "2026-02-30" },
		{ repositories: [""] },
		{ repositories: ["https://example.org/repo"] },
		{ repositories: ["/home/me/secret"] },
		{ repositories: ["C:\\work\\repo"] },
		{ repositories: ["file:repo"] },
		{ repositories: [7] },
		{ repositories: ["Safe label"], internalGitPath: "/Users/alice/private-repo", ownerEmail: "alice@example.org" },
	]) {
		assert.throws(() => validateBundle({ ...valid, context } as SourceBundle), /context/, JSON.stringify(context));
	}
});

test("rejects mixed, duplicate, malformed or incompletely declared monthly usage", () => {
	const first = monthlyUsage[0];
	for (const bundle of [
		rollup([...monthlyUsage, usage]),
		rollup([...monthlyUsage.slice(0, 11), { ...monthlyUsage[11], id: "other", provenance: { source: "monthly-usage-export", recordId: "other" }, month: "2026-11" }]),
		rollup([{ ...first, month: "2026-13" }, ...monthlyUsage.slice(1)]),
		rollup([{ ...first, tokens: -1 }, ...monthlyUsage.slice(1)]),
		rollup([{ ...first, tokens: Number.MAX_SAFE_INTEGER + 1 }, ...monthlyUsage.slice(1)]),
		rollup(monthlyUsage.slice(1)),
		rollup([]),
		rollup(monthlyUsage.slice(1), { status: "partial", eligible: 13, missing: 2, reason: "September unavailable." }),
	]) {
		assert.throws(() => validateBundle(bundle), /usage/);
	}
});

test("every record source requires unique, non-empty provenance", () => {
	const ids = { tickets: "API-1", commits: "abc123", usage: "usage-1", charges: "charge-1" };
	for (const source of ["tickets", "commits", "usage", "charges"] as const) {
		const absent = structuredClone(valid);
		delete (absent[source]![0] as { provenance?: unknown }).provenance;
		assert.throws(() => validateBundle(absent), new RegExp(`${source} ${ids[source]}: provenance`));
		for (const field of ["source", "recordId"] as const) {
			const blank = structuredClone(valid);
			blank[source]![0].provenance[field] = " ";
			assert.throws(() => validateBundle(blank), new RegExp(`${source} ${ids[source]}: provenance\\.${field}`));
		}
		const repeated = structuredClone(valid);
		if (source === "tickets") repeated.tickets!.push({ ...ticket, id: "API-2" });
		if (source === "commits") repeated.commits!.push({ ...commit, hash: "def456" });
		if (source === "usage") repeated.usage!.push({ ...usage, id: "usage-2" });
		if (source === "charges") repeated.charges!.push({ ...charge, id: "charge-2", month: "2026-02" });
		assert.throws(() => validateBundle(repeated), new RegExp(`${source} .*: provenance`));
	}
});

test("coverage counts must reconcile with status, reason and returned records", () => {
	const cases: [Partial<SourceBundle>, RegExp][] = [
		[{ coverage: withCoverage("usage", { missing: -1 }) }, /coverage usage: missing/],
		[{ coverage: valid.coverage.filter((entry) => entry.source !== "usage") }, /usage:.*coverage/],
		[{ usage: undefined, coverage: withCoverage("usage", { status: "partial", eligible: 0, extracted: 0, linked: 0, reason: "No export" }) }, /usage:.*coverage/],
		[{ coverage: withCoverage("usage", { eligible: 2, missing: 1 }) }, /coverage usage/],
		[{ coverage: withCoverage("usage", { status: "partial", eligible: 2, missing: 1 }) }, /coverage usage: reason/],
		[{ coverage: withCoverage("usage", { status: "partial", eligible: 3, missing: 1, reason: "Gap" }) }, /coverage usage: eligible/],
		[{ coverage: withCoverage("usage", { eligible: 2, extracted: 2 }) }, /usage/],
		...[
			{ status: "available", extracted: 1, linked: 2 },
			{ status: "available", extracted: 1, excluded: 2 },
			{ status: "available", extracted: 2, linked: 2, excluded: 1 },
			{ status: "available", eligible: 0 },
		].map((counts): [Partial<SourceBundle>, RegExp] => [{ coverage: withCoverage("usage", counts) }, /coverage usage: (extracted|linked|excluded)/]),
		...[{ extracted: 1 }, { linked: 1 }, { excluded: 1 }].map((counts): [Partial<SourceBundle>, RegExp] => [
			{ usage: undefined, coverage: withCoverage("usage", { status: "unavailable", eligible: 0, extracted: 0, linked: 0, reason: "No export", ...counts }) },
			/coverage usage: (extracted|linked|excluded)/,
		]),
	];
	for (const sourceKind of ["synthetic", "configured"] as const) {
		for (const [change, pattern] of cases)
			assert.throws(() => validateBundle({ ...valid, sourceKind, ...change }), pattern, `${sourceKind} ${String(pattern)} ${JSON.stringify(change.coverage?.[2])}`);
	}
});
