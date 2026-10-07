import assert from "node:assert/strict";
import test from "node:test";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { renderHtml } from "../src/html.js";
import type { SourceBundle, UsageEvent } from "../src/model.js";
import { buildReport } from "../src/report.js";

const detailedEvent: UsageEvent = {
	id: "detailed-1",
	provenance: { source: "test", recordId: "detailed-1" },
	at: "2025-09-18T10:00:00Z",
	model: "example-model",
	inputTokens: 100,
	cachedInputTokens: 40,
	outputTokens: 20,
	attempt: 1,
	outcome: "success",
};

const withoutUsage = (source: SourceBundle): SourceBundle => ({
	...source,
	usage: undefined,
	coverage: source.coverage.map((entry) =>
		entry.source === "usage" ? { source: "usage", status: "unavailable", eligible: 0, extracted: 0, linked: 0, excluded: 0, missing: 0, reason: "Not supplied." } : entry,
	),
});

const render = (source: SourceBundle): string => renderHtml(buildReport(source));
const section = (html: string, id: string): string => html.split(`<section id="${id}"`)[1]?.split("</section>")[0] ?? "";
const kpiValues = (html: string): string[] => [...section(html, "profile").matchAll(/class="kpi-value">([^<]*)</g)].map((match) => match[1]);
const embedded = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="report-data">([^<]*)<\/script>/)?.[1] ?? "null");

test("sections render in a fixed order and navigation links only to visible sections", () => {
	const html = render(loadSynthetic());
	const sections = [...html.matchAll(/<section id="([a-z-]+)"/g)].map((match) => match[1]);
	assert.deepEqual(sections, ["profile", "impact", "utilization", "issue-volume", "category-trends", "git", "ledger", "evidence", "actions"]);
	const nav = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
	assert.deepEqual(
		[...nav.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]),
		["profile", "impact", "utilization", "issue-volume", "git", "ledger", "evidence"],
	);
	assert.match(section(html, "profile"), /class="context-grid"[\s\S]*class="scope-note"[\s\S]*class="kpis"/);
	assert.equal((html.match(/class="chart" data-field="/g) ?? []).length, 5);
	assert.equal((html.match(/class="chart" data-comparison="/g) ?? []).length, 1);
	assert.match(html, /id="type-chart" role="group"/);
	assert.match(html, /@media print/);
	assert.doesNotMatch(html, /<a\s+[^>]*href="https?:\/\//i);
	assert.doesNotMatch(html.split("</main>")[0], /id="migration"/);
	assert.ok(embedded(html).migration);
});

test("profile shows supplied context only and never borrows synthetic context", () => {
	const source = loadSynthetic();
	const context = source.context;
	assert.ok(context);
	const shown = [
		context.owner,
		context.description,
		context.aiUse,
		context.concurrentChanges,
		context.question,
		context.includedWork,
		context.excludedWork,
		...(context.repositories ?? []),
	];
	const profile = section(render(source), "profile");
	for (const value of shown) assert.ok(value && profile.includes(value), value);
	for (const hidden of [context.controls, context.resourceLimits]) assert.ok(hidden && !profile.includes(hidden), hidden);
	const configured = render({ ...withoutUsage(source), context: undefined, sourceKind: "configured", endDate: "2025-09-30" });
	for (const value of shown) assert.ok(value && !configured.includes(value), value);
});

test("KPI totals qualify partial sources and keep missing sources unavailable", () => {
	const source = loadSynthetic();
	const partial = kpiValues(
		render({
			...source,
			tickets: [],
			commits: [],
			coverage: source.coverage.map((entry) =>
				entry.source === "tickets" || entry.source === "commits" ? { ...entry, status: "partial" as const, reason: "Incomplete." } : entry,
			),
		}),
	);
	assert.match(partial[1], /^0 .*partial/);
	assert.match(partial[2], /^0 .*partial/);
	const missing = kpiValues(
		render({
			...source,
			commits: undefined,
			usage: undefined,
			charges: undefined,
			coverage: source.coverage.map((entry) =>
				["commits", "usage", "charges"].includes(entry.source) ? { ...entry, status: "unavailable" as const, extracted: 0, linked: 0, reason: "Not supplied." } : entry,
			),
		}),
	);
	for (const index of [2, 3, 4]) assert.match(missing[index], /unavailable/i);
});

test("untrusted adapter fields and serialized data are inert", () => {
	const source = loadSynthetic();
	const hostile = "</script><script>alert(1)</script><img src=x onerror=alert(2)>";
	source.scope = hostile;
	source.completenessAttestation = hostile;
	source.context = { ...source.context, description: hostile };
	source.coverage[0].reason = hostile;
	source.coverage[1].status = 'available" onmouseover="alert(3)' as "available";
	source.tickets![0].type = hostile;
	source.usage = [{ ...detailedEvent, model: hostile }];
	source.charges![0].category = hostile;
	const html = render(source);
	assert.ok(!html.includes("<script>alert("));
	assert.ok(!html.includes("<img src=x"));
	assert.ok(!html.includes('onmouseover="alert(3)"'));
	assert.equal(embedded(html).operational.scope, hostile);
});

test("issue types get one chart each plus a separate total, including prototype-like names", () => {
	const source = loadSynthetic();
	const firstTicket = source.tickets?.[0];
	assert.ok(firstTicket);
	const types = ["__proto__", "constructor", "toString", "All created issues"];
	const tickets = types
		.map((type, index) => ({ ...firstTicket, id: `type-${index}`, type, status: "unknown" as const, approvals: [] }))
		.concat([{ ...firstTicket, id: "next-month", type: "__proto__", status: "unknown" as const, approvals: [], createdAt: "2025-10-02T12:00:00Z" }]);
	const html = render({ ...withoutUsage(source), sourceKind: "configured", endDate: "2025-10-31", tickets });
	assert.deepEqual(embedded(html).operational.monthly[0].issueTypes, JSON.parse('{"__proto__":1,"constructor":1,"toString":1,"All created issues":1}'));
	assert.deepEqual([...html.matchAll(/class="chart" data-type="([^"]*)"/g)].map((match) => match[1]).sort(), [...types].sort());
	assert.equal((html.match(/class="chart" data-total-issues="true"/g) ?? []).length, 1);
	assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("model breakdown appears only when event-level usage is recorded", () => {
	assert.ok(!render(loadSynthetic()).includes("example-model"));
	const source = loadSynthetic();
	source.usage = [detailedEvent];
	source.coverage = source.coverage.map((entry) =>
		entry.source === "usage" ? { ...entry, status: "partial", extracted: 1, eligible: 12, missing: 11, reason: "One event." } : entry,
	);
	const tokenCard = render(source).split('data-field="tokens"')[1]?.split("</figure>")[0];
	assert.match(tokenCard ?? "", /<th scope="row">example-model<\/th>/);
});

test("token comparison indexes to the first month with both measures positive", () => {
	const view = buildReport(loadSynthetic());
	const baseMonth = () => renderHtml(view).match(/data-comparison="tokens-approved" data-base-month="([^"]*)"/)?.[1];
	assert.equal(baseMonth(), "2025-09");
	view.operational.monthly[0].tokens = 0;
	assert.equal(baseMonth(), "2025-10");
	for (const month of view.operational.monthly) {
		month.tokens = null;
		month.measureStatus.tokens = "unavailable";
	}
	assert.equal(baseMonth(), "");
});

test("ledger rows mark the comparison periods only when a split exists", () => {
	const periods = (html: string) => new Set([...html.matchAll(/<tr data-period="([a-z]+)"/g)].map((match) => match[1]));
	const source = loadSynthetic();
	assert.deepEqual(periods(render(source)), new Set(["before", "after"]));
	assert.deepEqual(periods(render({ ...withoutUsage(source), sourceKind: "configured", endDate: "2025-09-30" })), new Set(["all"]));
});

test("Git diagnostics render as aggregates without contributor or path details", () => {
	const source = loadSynthetic();
	const first = source.commits?.[0];
	assert.ok(first);
	const observed = { linesAdded: 10, linesDeleted: 0, testLinesAdded: 0, sourceLinesAdded: 10, changeSize: 10 };
	const html = render({
		...source,
		commits: [
			{ ...first, hash: "first", paths: ["src/api.ts"], ...observed, contributorId: "private@example.org" },
			{ ...first, hash: "second", paths: ["tests/a.test.ts"], ...observed, contributorId: "other@example.org" },
		],
	});
	assert.doesNotMatch(html, /private@example\.org|other@example\.org|src\/api\.ts|tests\/a\.test\.ts/);
});
