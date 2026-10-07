import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLocalGit } from "../src/adapters/git.js";
import { loadConfigured } from "../src/adapters/load.js";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { aggregate } from "../src/aggregate.js";

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, name: string, file: string, message: string, date: string, committedAt = date, email = "private@example.org"): string {
	writeFileSync(join(repo, file), message);
	git(repo, "add", file);
	execFileSync("git", ["-C", repo, "commit", "-m", message], {
		env: {
			...process.env,
			GIT_AUTHOR_NAME: name,
			GIT_COMMITTER_NAME: name,
			GIT_AUTHOR_EMAIL: email,
			GIT_COMMITTER_EMAIL: email,
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: committedAt,
		},
	});
	return git(repo, "rev-parse", "HEAD");
}

function withRepo(run: (repo: string) => Promise<void> | void): Promise<void> {
	const repo = mkdtempSync(join(tmpdir(), "impact-git-"));
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Developer");
	git(repo, "config", "user.email", "private@example.org");
	return Promise.resolve()
		.then(() => run(repo))
		.finally(() => rmSync(repo, { recursive: true, force: true }));
}

const since = "2026-03-01";
const until = "2026-03-31";

/** Writes a configured report that reads commits from `repo` and, optionally, an API-101 ticket file. */
function writeConfig(directory: string, commits: object, withTickets = false): string {
	const sources: Record<string, object> = { commits: { kind: "git", path: directory, revision: "HEAD", ...commits } };
	if (withTickets) {
		writeFileSync(
			join(directory, "tickets.json"),
			JSON.stringify({ version: 1, tickets: [{ id: "API-101", type: "Story", createdAt: "2026-03-01T09:00:00Z", statusEvents: [] }] }),
		);
		sources.tickets = { kind: "file", path: "tickets.json", coverage: { status: "available", eligible: 1, extracted: 1, linked: 0, excluded: 0, missing: 0, reason: "" } };
	}
	const configPath = join(directory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			version: 1,
			scope: "Team",
			startDate: since,
			endDate: until,
			timezone: "UTC",
			extractedAt: "2026-04-01T00:00:00Z",
			currency: "EUR",
			completenessAttestation: "Local history.",
			sources,
		}),
	);
	return configPath;
}

test("local Git returns bounded history, paths and links without changing or exposing the repository", () =>
	withRepo((repo) => {
		const first = commit(repo, "Developer", "feature.test.ts", "API-101 add test", "2026-03-05T12:00:00Z");
		const second = commit(repo, "Developer", "feature.ts", "Refactor source", "2026-03-06T12:00:00Z");
		const before = git(repo, "status", "--porcelain=v1");
		const result = loadLocalGit(repo, "HEAD", since, until, "UTC", "API-[0-9]+");
		assert.deepEqual(
			result.commits.map((item) => [item.hash, item.parents, item.paths, item.ticketIds]),
			[
				[second, [first], ["feature.ts"], []],
				[first, [], ["feature.test.ts"], ["API-101"]],
			],
		);
		assert.deepEqual([result.coverage.eligible, result.coverage.extracted, result.coverage.linked, result.coverage.missing], [2, 2, 0, 0]);
		assert.equal(result.inspectedRevision, second);
		assert.match(result.extractedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
		assert.ok(!JSON.stringify(result).includes(repo));
		assert.ok(!JSON.stringify(result).includes("private@example.org"));
		assert.equal(git(repo, "rev-parse", "HEAD"), second);
		assert.equal(git(repo, "status", "--porcelain=v1"), before);
	}));

test("local Git keeps only pseudonymous distinct authors and classifies test/source additions", () =>
	withRepo((repo) => {
		const first = commit(repo, "One", "feature.ts", "Source", "2026-03-05T12:00:00Z", "2026-03-05T12:00:00Z", "one@example.org");
		const second = commit(repo, "Two", "feature.test.ts", "Test", "2026-03-06T12:00:00Z", "2026-03-06T12:00:00Z", "two@example.org");
		const result = loadLocalGit(repo, second, since, until, "UTC");
		assert.ok(result.commits.every((item) => item.contributorId && !item.contributorId.includes("@")));
		assert.notEqual(result.commits[0].contributorId, result.commits[1].contributorId);
		assert.equal(result.commits.find((item) => item.hash === first)?.sourceLinesAdded, 1);
		assert.equal(result.commits.find((item) => item.hash === second)?.testLinesAdded, 1);
		assert.equal(aggregate({ ...loadSynthetic(), commits: result.commits }).repositoryDiagnostics?.contributorCount, 2);
		assert.doesNotMatch(JSON.stringify(result), /one@example\.org|two@example\.org/);
	}));

test("invalid repositories, revisions and broken history fail without fallback or path disclosure", () =>
	withRepo(async (repo) => {
		const root = commit(repo, "Developer", "root.ts", "Root", "2026-03-04T12:00:00Z");
		commit(repo, "Developer", "tip.ts", "Tip", "2026-03-05T12:00:00Z");
		assert.throws(() => loadLocalGit(join(repo, "missing"), "HEAD", since, until, "UTC"));
		assert.throws(() => loadLocalGit(repo, "not-a-ref", since, until, "UTC"));
		const configPath = writeConfig(repo, {});
		rmSync(join(repo, ".git", "objects", root.slice(0, 2), root.slice(2)));
		const sanitized = (error: unknown) => error instanceof Error && !error.message.includes(repo);
		assert.throws(() => loadLocalGit(repo, "HEAD", since, until, "UTC"), sanitized);
		await assert.rejects(loadConfigured(configPath), sanitized);
	}));

test("shallow history is partial even when its visible commit falls inside the window", () =>
	withRepo(async (repo) => {
		commit(repo, "Developer", "root.ts", "API-100 root", "2026-03-04T12:00:00Z");
		const tip = commit(repo, "Developer", "tip.ts", "API-101 tip", "2026-03-05T12:00:00Z");
		const shallow = join(repo, "shallow");
		execFileSync("git", ["clone", "-q", "--depth", "1", "--no-local", repo, shallow]);
		assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
		const result = loadLocalGit(shallow, "HEAD", since, until, "UTC", "API-[0-9]+");
		assert.deepEqual(
			result.commits.map((item) => item.hash),
			[tip],
		);
		assert.equal(result.coverage.status, "partial");
		const report = aggregate(await loadConfigured(writeConfig(shallow, { ticketPattern: "API-[0-9]+" }, true)));
		const coverage = report.coverage.find((entry) => entry.source === "commits");
		assert.deepEqual([coverage?.status, coverage?.linked], ["partial", 1]);
		assert.equal(report.monthly[0].measureStatus.commits, "partial");
		assert.ok(report.evidenceGaps.some((gap) => gap.metric === "commits"));
		assert.equal(git(shallow, "rev-parse", "HEAD"), tip);
	}));

test("local calendar boundaries, ambiguous links, bot and merge exclusions are counted once", () =>
	withRepo((repo) => {
		commit(repo, "Developer", "before.ts", "API-001 outside local month", "2026-02-28T14:59:00Z");
		const testHash = commit(repo, "Developer", "new.test.ts", "API-101 and API-102", "2026-02-28T15:01:00Z");
		const botHash = commit(repo, "Build Service", "generated.ts", "API-101 generated", "2026-03-02T10:00:00Z");
		git(repo, "branch", "topic");
		commit(repo, "Developer", "main.ts", "API-103 main", "2026-03-03T10:00:00Z");
		git(repo, "checkout", "-q", "topic");
		commit(repo, "Developer", "topic.ts", "API-104 topic", "2026-03-03T11:00:00Z");
		git(repo, "checkout", "-q", "-");
		execFileSync("git", ["-C", repo, "merge", "--no-ff", "-q", "-m", "Merge topic", "topic"], {
			env: { ...process.env, GIT_AUTHOR_DATE: "2026-03-04T12:00:00Z", GIT_COMMITTER_DATE: "2026-03-04T12:00:00Z" },
		});
		const mergeHash = git(repo, "rev-parse", "HEAD");
		const result = loadLocalGit(repo, mergeHash, since, until, "Asia/Tokyo", "API-[0-9]+", ["Build Service"]);
		assert.deepEqual([result.coverage.eligible, result.coverage.extracted, result.coverage.excluded, result.coverage.linked], [3, 5, 2, 0]);
		assert.deepEqual(result.commits.find((item) => item.hash === testHash)?.ticketIds, ["API-101", "API-102"]);
		assert.equal(result.commits.find((item) => item.hash === botHash)?.bot, true);
		assert.equal(result.commits.find((item) => item.hash === mergeHash)?.parents.length, 2);
	}));

test("commit time, not author time or ancestry order, determines the reporting month", () =>
	withRepo((repo) => {
		const root = commit(repo, "Developer", "root.ts", "API-101 root", "2026-03-05T12:00:00Z");
		commit(repo, "Developer", "older.ts", "API-102 backdated", "2026-02-20T12:00:00Z");
		const delayed = commit(repo, "Developer", "delayed.ts", "API-200 delayed", "2026-02-25T12:00:00Z", "2026-03-01T00:30:00Z");
		const result = loadLocalGit(repo, delayed, since, until, "UTC", "API-[0-9]+");
		assert.deepEqual(
			result.commits.map((item) => item.hash),
			[delayed, root],
		);
		assert.deepEqual([result.commits[0].at, result.commits[0].linesAdded, result.commits[0].changeSize], ["2026-03-01T00:30:00Z", 1, 1]);
	}));

test("filenames with line breaks and zero-commit windows remain structured", () =>
	withRepo((repo) => {
		const file = "tests/weird\nname.test.ts";
		mkdirSync(join(repo, "tests"));
		const hash = commit(repo, "Developer", file, "API-101 unusual path", "2026-03-05T12:00:00Z");
		const result = loadLocalGit(repo, hash, since, until, "UTC", "API-[0-9]+");
		assert.deepEqual(result.commits[0].paths, [file]);
		assert.deepEqual(result.commits[0].ticketIds, ["API-101"]);
		const empty = loadLocalGit(repo, hash, "2026-04-01", "2026-04-30", "UTC");
		assert.deepEqual(empty.commits, []);
		assert.equal(empty.coverage.status, "available");
	}));

test("configured Git without tickets loads pinned history; Go and Python test paths count as test touches", () =>
	withRepo(async (repo) => {
		commit(repo, "Developer", "handler_test.go", "API-101 Go unit tests", "2026-03-05T12:00:00Z");
		commit(repo, "Developer", "test_handler.py", "Python unit tests", "2026-03-06T12:00:00Z");
		const tip = commit(repo, "Developer", "handler.go", "Source change", "2026-03-07T12:00:00Z");
		const bundle = await loadConfigured(writeConfig(repo, { ticketPattern: "API-[0-9]+" }));
		assert.equal(bundle.commits?.[0].hash, tip);
		assert.equal(bundle.coverage.find((entry) => entry.source === "commits")?.linked, 0);
		const march = aggregate(bundle).monthly[0];
		assert.deepEqual([march.commits, march.testTouchCommits, march.testTouchShare], [3, 2, 2 / 3]);
		assert.equal(march.measureStatus.commitLinks, "unavailable");
		assert.ok(!JSON.stringify(bundle).includes(repo));
		assert.ok(!JSON.stringify(bundle).includes("private@example.org"));
	}));

test("configured Git with tickets verifies only supplied keys and keeps the declared extraction date", () =>
	withRepo(async (repo) => {
		commit(repo, "Developer", "known.test.ts", "API-101 known", "2026-03-05T12:00:00Z");
		commit(repo, "Developer", "unknown.ts", "API-999 unknown", "2026-03-06T12:00:00Z");
		const tip = commit(repo, "Developer", "ambiguous.ts", "API-101 API-999", "2026-03-07T12:00:00Z");
		const bundle = await loadConfigured(writeConfig(repo, { revision: tip, ticketPattern: "API-[0-9]+" }, true));
		const report = aggregate(bundle);
		assert.equal(bundle.extractedAt, "2026-04-01T00:00:00Z");
		assert.equal(report.extractedAt, "2026-04-01T00:00:00Z");
		assert.equal(bundle.sources?.commits?.revision, tip);
		assert.equal(bundle.coverage.find((entry) => entry.source === "commits")?.linked, 1);
		assert.equal(report.coverage.find((entry) => entry.source === "commits")?.linked, 1);
		assert.deepEqual(report.monthly[0].commitLinks, { linked: 1, unlinked: 2, ambiguous: 1, excluded: 0 });
		assert.deepEqual([report.exclusions.unlinkedCommitLinks, report.exclusions.ambiguousCommitLinks], [2, 1]);
		assert.ok(!JSON.stringify(report).includes(repo));
	}));
