import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { isUnitTestPath } from "../commit-links.js";
import type { Commit, Coverage } from "../model.js";

const authorKey = randomBytes(32);

function git(repoPath: string, ...args: string[]): string {
	try {
		return execFileSync("git", ["-C", repoPath, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		throw new Error("Git history extraction command failed");
	}
}

function calendarDay(timestamp: string, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(timestamp));
	const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

function validDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function changedFiles(repoPath: string, hash: string): Pick<Commit, "paths" | "linesAdded" | "linesDeleted" | "changeSize" | "testLinesAdded" | "sourceLinesAdded"> {
	const output = git(repoPath, "diff-tree", "--root", "-r", "--no-commit-id", "--no-renames", "--numstat", "-z", hash);
	const paths: string[] = [];
	let linesAdded = 0;
	let linesDeleted = 0;
	let testLinesAdded = 0;
	let sourceLinesAdded = 0;
	let numeric = true;
	for (const entry of output.split("\0")) {
		if (!entry) continue;
		const firstTab = entry.indexOf("\t");
		const secondTab = entry.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0 || !entry.slice(secondTab + 1)) {
			throw new Error("Git history contains an invalid file record");
		}
		const path = entry.slice(secondTab + 1);
		paths.push(path);
		const added = Number(entry.slice(0, firstTab));
		const deleted = Number(entry.slice(firstTab + 1, secondTab));
		if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) numeric = false;
		else {
			linesAdded += added;
			linesDeleted += deleted;
			if (isUnitTestPath(path)) testLinesAdded += added;
			else if (/\.(?:[cm]?[jt]sx?|go|py|java|kt|rs|cs|rb|php|swift|c|cc|cpp|h|hpp)$/i.test(path)) {
				sourceLinesAdded += added;
			}
		}
	}
	return numeric ? { paths, linesAdded, linesDeleted, changeSize: linesAdded + linesDeleted, testLinesAdded, sourceLinesAdded } : { paths };
}

export function loadLocalGit(
	repoPath: string,
	revision: string,
	since: string,
	until: string,
	timezone: string,
	ticketPattern?: string,
	botAuthors: string[] = [],
): { commits: Commit[]; coverage: Coverage; inspectedRevision: string; extractedAt: string } {
	if (!validDate(since) || !validDate(until) || since > until) {
		throw new Error("Git window requires valid ordered ISO calendar dates");
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		throw new Error("Git timezone must be valid");
	}
	let pattern: RegExp | undefined;
	try {
		if (ticketPattern !== undefined) pattern = new RegExp(ticketPattern, "g");
	} catch {
		throw new Error("Git ticket pattern must be a valid regular expression");
	}
	if (!repoPath || !revision) throw new Error("Git repository path and revision are required");

	let inspectedRevision: string;
	let shallow: boolean;
	try {
		git(repoPath, "rev-parse", "--show-toplevel");
		shallow = git(repoPath, "rev-parse", "--is-shallow-repository").trim() === "true";
		inspectedRevision = git(repoPath, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`).trim();
		if (!/^[a-f0-9]{40,64}$/.test(inspectedRevision)) throw new Error("invalid object ID");
	} catch {
		throw new Error("Invalid local Git repository path or revision");
	}

	const start = new Date(`${since}T00:00:00Z`);
	const end = new Date(`${until}T00:00:00Z`);
	start.setUTCDate(start.getUTCDate() - 2);
	end.setUTCDate(end.getUTCDate() + 2);
	const output = git(
		repoPath,
		"log",
		"--no-patch",
		"-z",
		"--format=%x00%x00%H%x00%P%x00%cI%x00%an%x00%ae%x00%B",
		`--since-as-filter=${start.toISOString()}`,
		`--until=${end.toISOString()}`,
		inspectedRevision,
	);
	const commits: Commit[] = [];
	let excluded = 0;
	const fields = output.split("\0");
	let index = 0;
	while (index < fields.length) {
		while (fields[index] === "") index++;
		if (index >= fields.length) break;
		const [hash, parentList, at, author, email, message] = fields.slice(index, index + 6);
		index += 6;
		if (!/^[a-f0-9]{40,64}$/.test(hash) || !at || message === undefined) {
			throw new Error("Git history contains an invalid commit record");
		}
		if (calendarDay(at, timezone) < since || calendarDay(at, timezone) > until) continue;
		const parents = parentList ? parentList.split(" ") : [];
		const bot = /\[bot\]$/i.test(author) || botAuthors.includes(author);
		const ticketIds = [...new Set(pattern ? [...message.matchAll(pattern)].map((match) => match[0]) : [])];
		const commit: Commit = {
			hash,
			provenance: { source: "git:commits", recordId: hash },
			parents,
			at,
			...changedFiles(repoPath, hash),
			bot,
			ticketIds,
			contributorId: createHmac("sha256", authorKey)
				.update(email || author)
				.digest("hex"),
		};
		commits.push(commit);
		if (bot || parents.length > 1) excluded++;
	}
	const coverage: Coverage = {
		source: "commits",
		status: shallow ? "partial" : "available",
		eligible: commits.length - excluded,
		extracted: commits.length,
		linked: 0,
		excluded,
		missing: 0,
		reason: `Inspected revision ${inspectedRevision}.${shallow ? " Shallow repository: commit history is incomplete; earlier commits may be missing." : ""}`,
	};
	return { commits, coverage, inspectedRevision, extractedAt: new Date().toISOString() };
}
