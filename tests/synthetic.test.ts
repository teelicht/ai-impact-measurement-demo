import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { isMonthlyUsage } from "../src/model.js";
import { validateBundle } from "../src/validate.js";

const monthly = JSON.parse(readFileSync("data/api-team-monthly.json", "utf8")) as {
	rows: {
		month: string;
		approved: number;
		stories: number;
		commits: number;
		testTouches: number;
		bugs: number;
		tokensMillions: number;
		subscriptionEur: number;
		consumptionEur: number;
	}[];
};

test("expanded records are valid, deterministic and reconcile to every monthly target", () => {
	const bundle = loadSynthetic();
	assert.strictEqual(validateBundle(bundle), bundle);
	assert.deepEqual(loadSynthetic(), bundle);
	for (const [index, row] of monthly.rows.entries()) {
		const month = new Date(Date.UTC(2025, 8 + index, 1)).toISOString().slice(0, 7);
		const approved = bundle.tickets!.filter(
			(ticket) => !ticket.parentId && ["Story", "Task"].includes(ticket.type) && ticket.status === "approved" && ticket.approvals[0]?.at.startsWith(month),
		);
		assert.equal(approved.length, row.approved, `${row.month} approvals`);
		assert.equal(approved.filter((ticket) => ticket.type === "Story").length, row.stories, `${row.month} stories`);
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
		);
		assert.deepEqual(
			bundle.charges!.filter((charge) => charge.month === month).map((charge) => [charge.category, charge.amount]),
			[
				["subscription", row.subscriptionEur],
				["consumption", row.consumptionEur],
			],
		);
	}
	const commits = bundle.commits!;
	for (let index = 1; index < commits.length; index++) assert.deepEqual(commits[index].parents, [commits[index - 1].hash]);
});

test("usage is one monthly total per month with no invented breakdown or work-item links", () => {
	const bundle = loadSynthetic();
	assert.equal(bundle.usage?.length, 12);
	assert.ok(bundle.usage?.every(isMonthlyUsage));
	assert.equal(bundle.coverage.find((entry) => entry.source === "usage")?.linked, 0);
});

test("coverage reconciles with records, gaps stay unavailable and no contact data leaks", () => {
	const bundle = loadSynthetic();
	for (const source of ["tickets", "commits", "usage", "charges"] as const) {
		assert.equal(bundle.coverage.find((entry) => entry.source === source)?.extracted, bundle[source]!.length, source);
		assert.ok(
			bundle[source]!.every((record) => record.provenance.source && record.provenance.recordId),
			source,
		);
	}
	for (const source of ["historical-effort", "start-times", "defect-release-linkage"]) {
		assert.equal(bundle.coverage.find((entry) => entry.source === source)?.status, "unavailable");
	}
	assert.doesNotMatch(JSON.stringify(bundle), /https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
});
