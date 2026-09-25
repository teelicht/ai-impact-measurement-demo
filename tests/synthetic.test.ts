import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { isMonthlyUsage, type Ticket } from "../src/model.js";
import { validateBundle } from "../src/validate.js";

interface MonthlyRow {
	month: string;
	approved: number;
	commits: number;
	testTouches: number;
	bugs: number;
	tokensMillions: number;
	toolSpendEur: number;
}

const monthly = JSON.parse(readFileSync("data/api-team-monthly.json", "utf8")) as {
	version: number;
	metadata: { firstMonth: string; lastMonth: string; mappingNote: string };
	rows: MonthlyRow[];
};

test("versioned targets reproduce every appendix row and both period totals", () => {
	assert.equal(monthly.version, 1);
	assert.equal(monthly.metadata.firstMonth, "2025-09");
	assert.equal(monthly.metadata.lastMonth, "2026-08");
	assert.match(monthly.metadata.mappingNote, /illustrative/i);
	assert.deepEqual(monthly.rows, [
		{ month: "M1", approved: 18, commits: 100, testTouches: 12, bugs: 4, tokensMillions: 8, toolSpendEur: 80 },
		{ month: "M2", approved: 22, commits: 100, testTouches: 14, bugs: 5, tokensMillions: 9, toolSpendEur: 90 },
		{ month: "M3", approved: 20, commits: 100, testTouches: 15, bugs: 3, tokensMillions: 10, toolSpendEur: 100 },
		{ month: "M4", approved: 24, commits: 100, testTouches: 16, bugs: 4, tokensMillions: 11, toolSpendEur: 110 },
		{ month: "M5", approved: 19, commits: 100, testTouches: 14, bugs: 5, tokensMillions: 10, toolSpendEur: 100 },
		{ month: "M6", approved: 23, commits: 100, testTouches: 19, bugs: 3, tokensMillions: 12, toolSpendEur: 120 },
		{ month: "M7", approved: 24, commits: 100, testTouches: 20, bugs: 3, tokensMillions: 12, toolSpendEur: 120 },
		{ month: "M8", approved: 27, commits: 100, testTouches: 22, bugs: 5, tokensMillions: 14, toolSpendEur: 140 },
		{ month: "M9", approved: 25, commits: 100, testTouches: 24, bugs: 4, tokensMillions: 15, toolSpendEur: 150 },
		{ month: "M10", approved: 30, commits: 100, testTouches: 25, bugs: 3, tokensMillions: 16, toolSpendEur: 160 },
		{ month: "M11", approved: 28, commits: 100, testTouches: 27, bugs: 5, tokensMillions: 16, toolSpendEur: 160 },
		{ month: "M12", approved: 34, commits: 100, testTouches: 32, bugs: 4, tokensMillions: 17, toolSpendEur: 170 },
	]);
	const sum = (rows: MonthlyRow[], field: keyof Omit<MonthlyRow, "month">) => rows.reduce((total, row) => total + row[field], 0);
	for (const [rows, totals] of [
		[monthly.rows.slice(0, 6), [126, 600, 90, 24, 60, 600]],
		[monthly.rows.slice(6), [168, 600, 150, 24, 90, 900]],
	] as const) {
		assert.deepEqual(
			(["approved", "commits", "testTouches", "bugs", "tokensMillions", "toolSpendEur"] as const).map((field) => sum(rows, field)),
			totals,
		);
	}
});

test("expanded records reconcile to each monthly target and are reproducible", () => {
	const bundle = loadSynthetic();
	assert.strictEqual(validateBundle(bundle), bundle);
	assert.deepEqual(loadSynthetic(), bundle);
	assert.equal(bundle.sourceKind, "synthetic");
	assert.equal(bundle.startDate, "2025-09-01");
	assert.equal(bundle.endDate, "2026-08-31");
	assert.equal(
		bundle.tickets?.some((ticket) => ticket.startedAt !== undefined),
		false,
	);
	for (const [index, row] of monthly.rows.entries()) {
		const month = new Date(Date.UTC(2025, 8 + index, 1)).toISOString().slice(0, 7);
		const approved: Ticket[] = bundle.tickets!.filter(
			(ticket) => !ticket.parentId && ["Story", "Task"].includes(ticket.type) && ticket.status === "approved" && ticket.approvals[0]?.at.startsWith(month),
		);
		assert.equal(approved.length, row.approved, `${row.month} first approvals`);
		const commits = bundle.commits!.filter((commit) => commit.at.startsWith(month));
		assert.equal(commits.length, row.commits, `${row.month} commits`);
		assert.equal(commits.filter((commit) => commit.paths.some((path) => path.includes(".test."))).length, row.testTouches, `${row.month} test touches`);
		assert.equal(bundle.tickets!.filter((ticket) => ticket.type === "Bug" && ticket.createdAt.startsWith(month)).length, row.bugs, `${row.month} bugs`);
		assert.deepEqual(
			bundle.usage
				?.filter(isMonthlyUsage)
				.filter((record) => record.month === month)
				.map((record) => record.tokens),
			[row.tokensMillions * 1_000_000],
			`${row.month} monthly tokens`,
		);
		assert.equal(
			bundle.charges!.filter((charge) => charge.month === month).reduce((total, charge) => total + charge.amount, 0),
			row.toolSpendEur,
			`${row.month} spend`,
		);
	}
	assert.equal(bundle.commits?.filter((commit) => commit.at.startsWith("2026-03")).length, 100);
});

test("each month has only one token total and no invented event categories", () => {
	const bundle = loadSynthetic();
	const events = bundle.usage;
	assert.ok(events);
	assert.equal(events.length, 12);
	assert.ok(events.every(isMonthlyUsage));
	assert.ok(events.every((event) => !("model" in event) && !("cachedInputTokens" in event) && !("outcome" in event) && !("ticketId" in event)));
});

test("synthetic token totals have monthly scope and no work-item links", () => {
	const bundle = loadSynthetic();
	assert.ok(bundle.usage);
	assert.ok(bundle.usage.every((event) => !("ticketId" in event)));
	const coverage = bundle.coverage.find((entry) => entry.source === "usage");
	assert.equal(coverage?.status, "available");
	assert.equal(coverage?.linked, 0);
	assert.match(coverage?.reason ?? "", /month|task|work.item/i);
});

test("M7 first commit has a pinned SHA256 hash and follows the last M6 commit", () => {
	const commits = loadSynthetic().commits;
	assert.ok(commits);
	const lastM6 = commits.filter((commit) => commit.at.startsWith("2026-02")).at(-1);
	const firstM7 = commits.find((commit) => commit.at.startsWith("2026-03") && commit.ticketIds.includes("API-103"));
	assert.equal(lastM6?.hash, "d9b4fd5b0edeaed46bd345092b661572ed7a472fb81dc67ed210d0852e3742b8");
	assert.equal(firstM7?.hash, "c7098aaf4179920ab1d6960f715093cc71211889dd095a7b055e42287d2d61a1");
	assert.deepEqual(firstM7?.parents, [lastM6?.hash]);
	for (let index = 1; index < commits.length; index++) {
		assert.deepEqual(commits[index].parents, [commits[index - 1].hash], `commit ${index} parent`);
	}
});

test("March inclusion decisions, attempt accounting and source gaps remain inspectable", () => {
	const bundle = loadSynthetic();
	const tickets = bundle.tickets;
	assert.ok(tickets);
	const ticket = (id: string) => tickets.find((item) => item.id === id);
	assert.equal(ticket("API-101")?.type, "Story");
	assert.equal(ticket("API-101")?.status, "approved");
	assert.equal(ticket("API-101")?.approvals.length, 1);
	assert.equal(ticket("API-102")?.type, "Task");
	assert.equal(ticket("API-102")?.status, "approved");
	assert.equal(ticket("API-102")?.approvals.length, 2);
	assert.equal(ticket("API-102")?.approvals[0].at.startsWith("2026-03"), true);
	assert.equal(ticket("API-103")?.parentId, "API-101");
	assert.equal(ticket("API-103")?.status, "unknown");
	assert.deepEqual(ticket("API-103")?.approvals, []);
	assert.equal(ticket("API-104")?.status, "open");
	assert.deepEqual(ticket("API-104")?.approvals, []);
	assert.equal(tickets.filter((item) => item.status === "open").length, 1);
	assert.equal(
		tickets.filter((item) => item.type === "Bug").every((item) => item.status === "unknown"),
		true,
	);
	assert.equal(
		bundle.commits!.some((commit) => commit.ticketIds.includes("API-103") && commit.paths.some((path) => path.includes(".test."))),
		true,
	);
	assert.deepEqual(
		bundle
			.usage!.filter(isMonthlyUsage)
			.filter((event) => event.month === "2026-03")
			.map((event) => event.tokens),
		[12_000_000],
	);
	for (const source of ["tickets", "commits", "usage", "charges"] as const) {
		const coverage = bundle.coverage.find((entry) => entry.source === source)!;
		assert.equal(coverage.extracted, bundle[source]!.length, `${source} coverage`);
		if (source === "usage") {
			assert.equal(coverage.eligible, coverage.extracted);
			assert.equal(coverage.linked, 0);
			assert.equal(coverage.missing, 0);
		} else {
			assert.equal(coverage.eligible, coverage.linked + coverage.missing + (source === "tickets" ? 1 : 0), `${source} eligible reconciliation`);
			assert.equal(coverage.extracted, coverage.linked + coverage.excluded + (source === "tickets" ? 1 : 0), `${source} extraction reconciliation`);
		}
		assert.equal(
			bundle[source]!.every((record) => record.provenance.source && record.provenance.recordId),
			true,
			`${source} provenance`,
		);
	}
	for (const source of ["historical-effort", "start-times", "defect-release-linkage"]) {
		assert.equal(bundle.coverage.find((entry) => entry.source === source)?.status, "unavailable");
	}
	assert.doesNotMatch(JSON.stringify(bundle), /https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
});

test("separate USD migration ledger records verification and excludes overlapping hours", () => {
	const ledger = JSON.parse(readFileSync("data/migration.json", "utf8")) as {
		version: number;
		currency: string;
		period: string;
		claims: { id: string; category: string; amount: number; verificationStatus: string; overlapsWith?: string }[];
	};
	assert.equal(ledger.version, 1);
	assert.equal(ledger.currency, "USD");
	assert.equal(ledger.period, "12 weeks");
	assert.deepEqual(
		ledger.claims.map((claim) => [claim.id, claim.amount, claim.verificationStatus]),
		[
			["MIG-01", 35_000, "verified"],
			["MIG-COST-01", 4_000, "verified"],
			["MIG-COST-02", 6_000, "verified"],
			["MIG-COST-03", 8_000, "verified"],
			["MIG-COST-04", 2_000, "verified"],
			["MIG-DUP-01", 2_400, "excluded"],
		],
	);
	assert.equal(ledger.claims.at(-1)?.overlapsWith, "MIG-01");
	const verifiedCosts = ledger.claims.filter((claim) => claim.category === "cost" && claim.verificationStatus === "verified").reduce((total, claim) => total + claim.amount, 0);
	const verifiedAvoidedCost = ledger.claims
		.filter((claim) => claim.category === "avoided-cost" && claim.verificationStatus === "verified")
		.reduce((total, claim) => total + claim.amount, 0);
	assert.equal(verifiedCosts, 20_000);
	assert.equal(verifiedAvoidedCost - verifiedCosts, 15_000);
	assert.equal((verifiedAvoidedCost - verifiedCosts) / verifiedCosts, 0.75);
});
