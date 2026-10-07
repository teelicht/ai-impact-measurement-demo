import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const exampleConfig = fileURLToPath(new URL("../../examples/config.json", import.meta.url));
const run = (args: string[], cwd?: string) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd });

function withTemp(prefix: string, body: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	try {
		body(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("default CLI writes one synthetic HTML report and evidence JSON", () =>
	withTemp("ai-report-", (output) => {
		const result = run(["--out", output]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readdirSync(output).sort(), ["api-team-evidence.json", "api-team.html"]);
		const evidence = JSON.parse(readFileSync(join(output, "api-team-evidence.json"), "utf8"));
		assert.equal(evidence.sourceKind, "synthetic");
		assert.equal(evidence.monthly.length, 12);
		assert.deepEqual(
			evidence.periods.map((period: { approvedParents: number }) => period.approvedParents),
			[126, 168],
		);
		assert.equal(evidence.totalAiCost, null);
		assert.match(readFileSync(join(output, "api-team.html"), "utf8"), /id="report-data"/);
	}));

test("configured exports keep their window, unavailable sources and supplied context", () =>
	withTemp("ai-report-config-", (output) => {
		assert.equal(run(["--config", exampleConfig, "--out", output]).status, 0);
		const evidence = JSON.parse(readFileSync(join(output, "example-api-team-evidence.json"), "utf8"));
		assert.equal(evidence.sourceKind, "configured");
		assert.deepEqual(
			evidence.monthly.map((row: { month: string }) => row.month),
			["2026-03"],
		);
		assert.deepEqual(evidence.periods, []);
		assert.equal(evidence.context, null);
		assert.equal(evidence.coverage.find((entry: { source: string }) => entry.source === "commits").status, "unavailable");

		const configuration = JSON.parse(readFileSync(exampleConfig, "utf8"));
		const context = { owner: "Service lead", updatedAt: "2026-04-02", repositories: ["Checkout history"] };
		writeFileSync(join(output, "config.json"), JSON.stringify({ ...configuration, sources: {}, context }));
		assert.equal(run(["--config", join(output, "config.json"), "--out", output]).status, 0);
		assert.deepEqual(JSON.parse(readFileSync(join(output, "example-api-team-evidence.json"), "utf8")).context, context);
	}));

test("invalid invocations fail before writing output", () =>
	withTemp("ai-report-bad-", (output) => {
		assert.notEqual(run(["--config", join(output, "missing.json"), "--out", output]).status, 0);
		assert.notEqual(run(["--out", "first", "--out", "second"], output).status, 0);
		assert.deepEqual(readdirSync(output), []);
		assert.equal(existsSync(join(output, "first")), false);
	}));

test("configured exports use safe scope slugs with a fallback for empty slugs", () =>
	withTemp("ai-report-scope-", (root) => {
		const config = JSON.parse(readFileSync(exampleConfig, "utf8"));
		config.sources.tickets.path = fileURLToPath(new URL("../../examples/tickets.json", import.meta.url));
		const output = join(root, "exports");
		for (const [scope, base] of [
			["../Finance / Platform", "finance-platform"],
			[".../../", "team-report"],
		]) {
			writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, scope }));
			assert.equal(run(["--config", join(root, "config.json"), "--out", output]).status, 0);
			assert.deepEqual(readdirSync(output).sort(), [`${base}-evidence.json`, `${base}.html`]);
			rmSync(output, { recursive: true });
		}
	}));
