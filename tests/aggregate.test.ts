import assert from "node:assert/strict";
import test from "node:test";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { aggregate, countApprovedParents } from "../src/aggregate.js";
import type { Commit, Coverage, SourceBundle, Ticket } from "../src/model.js";
import { isMonthlyUsage } from "../src/model.js";
import { validateBundle } from "../src/validate.js";

const ticket = (id: string, overrides: Partial<Ticket>): Ticket => ({
	id,
	provenance: { source: "test", recordId: id },
	type: "Story",
	status: "approved",
	createdAt: "2026-02-01T00:00:00Z",
	approvals: [{ at: "2026-03-02T00:00:00Z", releaseId: "release-1" }],
	...overrides,
});

const withoutUsage = (source: SourceBundle): SourceBundle => ({
	...source,
	usage: undefined,
	coverage: source.coverage.map((entry) =>
		entry.source === "usage" ? { source: "usage", status: "unavailable", eligible: 0, extracted: 0, linked: 0, excluded: 0, missing: 0, reason: "Not supplied." } : entry,
	),
});

const withCoverage = (source: SourceBundle, sources: string[], change: Partial<Coverage>): Coverage[] =>
	source.coverage.map((entry) => (sources.includes(entry.source) ? { ...entry, ...change } : entry));

const hasGap = (report: ReturnType<typeof aggregate>, metric: string) => report.evidenceGaps.some((gap) => gap.metric === metric);

test("each eligible parent counts once, in its first approval month in the report timezone", () => {
	const approvals = countApprovedParents(
		[
			ticket("parent", {
				approvals: [
					{ at: "2026-03-02T00:00:00Z", releaseId: "release-1" },
					{ at: "2026-04-02T00:00:00Z", releaseId: "release-2" },
				],
			}),
			ticket("child", { parentId: "parent" }),
			ticket("emergency", { emergency: true }),
			ticket("open", { status: "open", approvals: [] }),
		],
		"UTC",
	);
	assert.deepEqual([...approvals], [["2026-03", 1]]);
	assert.deepEqual([...countApprovedParents([ticket("boundary", { approvals: [{ at: "2026-03-01T00:30:00Z", releaseId: "r" }] })], "America/Los_Angeles")], [["2026-02", 1]]);
});

test("synthetic monthly rows and period totals match the appendix", () => {
	const report = aggregate(loadSynthetic());
	assert.deepEqual(
		report.monthly.map((row) => [row.label, row.approvedParents, row.commits, row.testTouchCommits, row.incomingBugs, row.tokens, row.toolSpend]),
		[
			["M1", 18, 100, 12, 4, 40_000_000, 300],
			["M2", 22, 100, 14, 5, 50_000_000, 320],
			["M3", 20, 100, 15, 3, 46_000_000, 310],
			["M4", 24, 100, 16, 4, 56_000_000, 330],
			["M5", 19, 100, 14, 5, 46_000_000, 310],
			["M6", 23, 100, 19, 3, 56_000_000, 330],
			["M7", 24, 104, 20, 3, 70_000_000, 360],
			["M8", 27, 108, 22, 5, 86_000_000, 385],
			["M9", 25, 106, 24, 4, 88_000_000, 390],
			["M10", 30, 114, 25, 3, 114_000_000, 430],
			["M11", 28, 112, 27, 5, 115_000_000, 430],
			["M12", 34, 120, 32, 4, 150_000_000, 480],
		],
	);
	assert.deepEqual(
		report.periods.map((row) => [row.label, row.approvedParents, row.commits, row.testTouchShare, row.incomingBugs, row.tokens, row.toolSpend]),
		[
			["M1-M6", 126, 600, 90 / 600, 24, 294_000_000, 1900],
			["M7-M12", 168, 664, 150 / 664, 24, 623_000_000, 2475],
		],
	);
	assert.equal(report.comparisons.approvedParentsRelativeChange, 168 / 126 - 1);
	assert.equal(report.comparisons.testTouchSharePercentagePoints, (150 / 664 - 90 / 600) * 100);
	const march = report.monthly[6];
	assert.deepEqual(march.billingCategories, { subscription: 210, consumption: 150 });
	assert.equal(march.toolSpendPerApprovedParent, 15);
	assert.equal(march.usage?.byModel, null);
	assert.equal(report.totalAiCost, null);
	assert.equal(report.roi, null);
});

test("configured windows split into adjacent halves and a single month has no comparison", () => {
	const source = withoutUsage(loadSynthetic());
	const fourteen = aggregate({ ...source, sourceKind: "configured", endDate: "2026-10-31" });
	assert.deepEqual(
		fourteen.periods.map((row) => [row.startMonth, row.endMonth, row.approvedParents]),
		[
			["2025-09", "2026-03", 150],
			["2026-04", "2026-10", 144],
		],
	);
	const single = aggregate({ ...source, sourceKind: "configured", endDate: "2025-09-30" });
	assert.deepEqual(single.periods, []);
	assert.equal(single.comparisons.approvedParentsRelativeChange, null);
});

test("period token totals reject values beyond safe integer precision", () => {
	const source = loadSynthetic();
	const usage = source.usage?.filter(isMonthlyUsage).map((record, index) => ({ ...record, tokens: index === 0 ? Number.MAX_SAFE_INTEGER : index === 1 ? 2 : 0 }));
	assert.throws(() => aggregate({ ...source, usage }), /tokens/i);
});

test("issue mix, open parents, missing approvals and unknown metrics stay distinct", () => {
	const report = aggregate(loadSynthetic());
	const march = report.monthly[6];
	assert.deepEqual({ ...march.issueTypes }, { Story: 17, Task: 8, "Sub-task": 1, Bug: 3 });
	assert.deepEqual([march.createdParents, march.openParents, march.missingApproval, march.missingStartTimes], [25, 1, 0, 24]);
	assert.deepEqual([report.exclusions.duplicateApprovals, report.exclusions.children, report.exclusions.bugsWithUnknownReleaseLinkage], [1, 1, 48]);
	for (const metric of ["escapedDefects", "leadTime", "humanEffort", "releaseDiagnostics", "repositoryDiagnostics"] as const) {
		assert.equal(report[metric], null, metric);
		assert.ok(hasGap(report, metric), metric);
	}
	const unknownStatus = aggregate({
		...loadSynthetic(),
		tickets: [
			ticket("unknown-parent", { status: "unknown", approvals: [], createdAt: "2026-03-01T00:00:00Z" }),
			ticket("open-parent", { status: "open", approvals: [], createdAt: "2026-03-01T00:00:00Z" }),
			ticket("child", { parentId: "unknown-parent", status: "unknown", approvals: [], createdAt: "2026-03-01T00:00:00Z" }),
		],
	});
	assert.deepEqual([unknownStatus.monthly[6].createdParents, unknownStatus.monthly[6].missingApproval, unknownStatus.monthly[6].openParents], [2, 1, 1]);
});

test("prototype-like issue types are ordinary keys in monthly and period groups", () => {
	const source = loadSynthetic();
	const firstTicket = source.tickets?.[0];
	assert.ok(firstTicket);
	const tickets = [
		["proto-sep", "__proto__", "2025-09-02"],
		["constructor-sep", "constructor", "2025-09-03"],
		["proto-oct", "__proto__", "2025-10-02"],
		["string-oct", "toString", "2025-10-03"],
	].map(([id, type, date]) => ({ ...firstTicket, id, type, createdAt: `${date}T12:00:00Z`, status: "unknown" as const, approvals: [] }));
	const report = aggregate({ ...withoutUsage(source), sourceKind: "configured", endDate: "2025-12-31", tickets });
	assert.equal(Object.getPrototypeOf(report.monthly[0].issueTypes), null);
	assert.deepEqual(JSON.parse(JSON.stringify(report.periods[0].issueTypes)), JSON.parse('{"__proto__":2,"constructor":1,"toString":1}'));
	assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("incoming bugs count production only and qualify unknown environments", () => {
	const source = loadSynthetic();
	const bug = (id: string, production?: boolean) => ticket(id, { type: "Bug", status: "unknown", approvals: [], production, createdAt: "2026-03-11T00:00:00Z" });
	const report = aggregate({ ...source, tickets: [bug("prod", true), bug("nonprod", false), bug("unspecified")] });
	assert.equal(report.monthly[6].incomingBugs, 1);
	assert.equal(report.monthly[6].unknownProductionBugs, 1);
	assert.equal(report.periods[1].measureStatus.incomingBugs, "partial");
	assert.ok(hasGap(report, "incomingBugs"));
	assert.equal(aggregate(source).monthly[6].measureStatus.incomingBugs, "available");
});

test("commit counting excludes merges and bots, counts test paths once and buckets links", () => {
	const source = loadSynthetic();
	const commit = (hash: string, overrides: Partial<Commit>): Commit => ({
		hash,
		provenance: { source: "test", recordId: hash },
		parents: ["one"],
		at: "2026-03-12T12:00:00Z",
		paths: ["src/api.ts", "tests/api.test.ts", "tests/more.spec.ts"],
		bot: false,
		ticketIds: ["API-101"],
		...overrides,
	});
	const report = aggregate({
		...source,
		commits: [
			commit("linked", {}),
			commit("unlinked", { ticketIds: [] }),
			commit("ambiguous", { ticketIds: ["API-101", "API-102"] }),
			commit("unknown-mix", { ticketIds: ["API-101", "UNKNOWN"] }),
			commit("merge", { parents: ["one", "two"] }),
			commit("bot", { bot: true }),
			commit("source-only", { paths: ["src/contest.ts"] }),
		],
	});
	const march = report.monthly[6];
	assert.equal(march.commits, 5);
	assert.equal(march.testTouchCommits, 4);
	assert.deepEqual(march.commitLinks, { linked: 2, unlinked: 3, ambiguous: 2, excluded: 2 });
	assert.deepEqual([report.exclusions.mergeCommits, report.exclusions.botCommits], [1, 1]);
});

test("period test-touch share divides combined counts, not an average of monthly shares", () => {
	const source = loadSynthetic();
	const commits = source.commits ?? [];
	const first = commits.filter((commit) => commit.at.startsWith("2025-09")).slice(20, 21);
	const second = commits.filter((commit) => commit.at.startsWith("2025-10"));
	const report = aggregate({ ...source, commits: [...first, ...second.slice(0, 2), ...second.slice(20, 21)] });
	assert.equal(report.monthly[0].testTouchShare, 0);
	assert.equal(report.monthly[1].testTouchShare, 2 / 3);
	assert.equal(report.periods[0].testTouchShare, 2 / 4);
});

test("repository diagnostics aggregate observed fields without exposing identities", () => {
	const source = loadSynthetic();
	const first = source.commits?.[0];
	assert.ok(first);
	const commits: Commit[] = [
		{ ...first, hash: "small", paths: ["src/a.ts"], linesAdded: 10, linesDeleted: 0, changeSize: 10, testLinesAdded: 0, sourceLinesAdded: 10, contributorId: "private-a" },
		{
			...first,
			hash: "medium",
			paths: ["tests/a.test.ts", "src/a.ts"],
			linesAdded: 30,
			linesDeleted: 0,
			changeSize: 30,
			testLinesAdded: 10,
			sourceLinesAdded: 20,
			contributorId: "private-a",
		},
		{
			...first,
			hash: "large",
			paths: ["tests/b.test.ts", "src/b.ts"],
			linesAdded: 10,
			linesDeleted: 140,
			changeSize: 150,
			testLinesAdded: 5,
			sourceLinesAdded: 5,
			contributorId: "private-b",
		},
		{ ...first, hash: "merge", parents: ["one", "two"], linesAdded: 1000, linesDeleted: 1000, changeSize: 2000, contributorId: "excluded" },
	];
	const report = aggregate({ ...source, commits });
	assert.deepEqual(report.repositoryDiagnostics, {
		churn: { linesAdded: 50, linesDeleted: 140 },
		contributorCount: 2,
		meanChangeSize: 190 / 3,
		medianChangeSize: 30,
		largeChangeShare: 1 / 3,
		testToSourceRatio: 15 / 35,
	});
	assert.equal(report.definitions.find((entry) => entry.metric === "repositoryDiagnostics")?.coverage, "available");
	assert.doesNotMatch(JSON.stringify(report), /private-[ab]|src\/b\.ts/);
});

test("incomplete commit observations leave unsupported diagnostics null and coverage partial", () => {
	const source = loadSynthetic();
	const first = source.commits?.[0];
	assert.ok(first);
	const report = aggregate({
		...source,
		commits: [
			{ ...first, linesAdded: 12, linesDeleted: 4, contributorId: "person-1", changeSize: 10 },
			{ ...first, hash: "second", contributorId: "person-2" },
		],
	});
	assert.deepEqual(report.repositoryDiagnostics, {
		churn: null,
		contributorCount: 2,
		meanChangeSize: null,
		medianChangeSize: null,
		largeChangeShare: null,
		testToSourceRatio: null,
	});
	assert.equal(report.definitions.find((entry) => entry.metric === "repositoryDiagnostics")?.coverage, "partial");
	assert.ok(hasGap(report, "repositoryDiagnostics"));
});

test("missing, partial or empty sources never become complete zeroes or comparisons", () => {
	const source = loadSynthetic();
	const missing = aggregate({
		...source,
		usage: undefined,
		charges: undefined,
		coverage: withCoverage(source, ["usage", "charges"], { status: "unavailable", extracted: 0, linked: 0, reason: "No export." }),
	});
	assert.equal(missing.monthly[0].tokens, null);
	assert.equal(missing.monthly[0].toolSpend, null);
	assert.ok(hasGap(missing, "tokens"));

	const partial = aggregate({ ...source, tickets: [], commits: [], coverage: withCoverage(source, ["tickets", "commits"], { status: "partial", reason: "Incomplete." }) });
	assert.equal(partial.monthly[0].approvedParents, 0);
	for (const key of ["approvedParents", "incomingBugs", "commits", "testTouchShare"] as const) assert.equal(partial.monthly[0].measureStatus[key], "partial", key);
	assert.equal(partial.periods[0].measureStatus.approvedParents, "partial");

	const partialComparisons = aggregate({ ...source, coverage: withCoverage(source, ["tickets", "commits"], { status: "partial", reason: "Incomplete." }) }).comparisons;
	assert.deepEqual(
		[
			partialComparisons.approvedParentsRelativeChange,
			partialComparisons.incomingBugsRelativeChange,
			partialComparisons.commitsRelativeChange,
			partialComparisons.testTouchSharePercentagePoints,
		],
		[null, null, null, null],
	);

	const empty = aggregate({ ...source, usage: [], charges: [] });
	assert.equal(empty.monthly[0].measureStatus.tokens, "partial");
	assert.equal(empty.periods[0].measureStatus.toolSpend, "partial");
	assert.ok(hasGap(empty, "tokens") && hasGap(empty, "toolSpend"));
});

test("lead time needs start evidence for every approved parent and complete ticket coverage", () => {
	const source = loadSynthetic();
	const startsAvailable = (count: number) =>
		withCoverage(source, ["start-times"], { status: "available", eligible: count, extracted: count, linked: count, missing: 0, reason: "" });
	const withStart = ticket("with-start", { startedAt: "2026-02-20T00:00:00Z" });
	const withoutStart = ticket("without-start", {});
	assert.equal(aggregate({ ...source, tickets: [withStart, withoutStart] }).leadTime, null);
	const complete = aggregate({ ...source, tickets: [withStart, { ...withoutStart, startedAt: "2026-02-28T00:00:00Z" }], coverage: startsAvailable(2) });
	assert.equal(complete.leadTime, 6);
	assert.equal(hasGap(complete, "leadTime"), false);
	const partialTickets = aggregate({
		...source,
		tickets: [withStart],
		coverage: startsAvailable(1).map((entry) => (entry.source === "tickets" ? { ...entry, status: "partial" as const, reason: "Incomplete." } : entry)),
	});
	assert.equal(partialTickets.leadTime, null);
});

test("lead time uses the first approval inside the reporting window", () => {
	const source = loadSynthetic();
	const inWindow = ticket("in-window", {
		startedAt: "2026-02-28T00:00:00Z",
		approvals: [
			{ at: "2026-03-02T00:00:00Z", releaseId: "first" },
			{ at: "2026-03-22T00:00:00Z", releaseId: "second" },
		],
	});
	const outside = ticket("outside", { createdAt: "2026-09-01T00:00:00Z", approvals: [{ at: "2026-09-20T00:00:00Z", releaseId: "later" }] });
	const coverage = withCoverage(source, ["start-times"], { status: "available", eligible: 1, extracted: 1, linked: 1, missing: 0, reason: "" });
	assert.equal(aggregate({ ...source, tickets: [inWindow, outside], coverage }).leadTime, 2);
	assert.throws(() => validateBundle({ ...source, tickets: [{ ...inWindow, approvals: [...inWindow.approvals].reverse() }] }), /approvals/);
});
