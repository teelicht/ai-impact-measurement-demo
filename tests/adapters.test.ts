import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTicketFile } from "../src/adapters/files.js";
import { loadConfigured } from "../src/adapters/load.js";
import { loadSynthetic } from "../src/adapters/synthetic.js";
import { isMonthlyUsage, type UsageEvent } from "../src/model.js";

const available = { status: "available", eligible: 1, extracted: 1, linked: 0, excluded: 0, missing: 0, reason: "" };

const config = {
	version: 1,
	scope: "Example API team",
	startDate: "2026-03-01",
	endDate: "2026-03-31",
	timezone: "UTC",
	extractedAt: "2026-04-01T00:00:00Z",
	currency: "EUR",
	completenessAttestation: "Only declared sources were extracted.",
	sources: { tickets: { kind: "file", path: "tickets.json", coverage: { ...available, eligible: 2, extracted: 2 } } },
};

const story = { id: "API-101", type: "Story", createdAt: "2026-03-01T09:00:00Z", statusEvents: [] as object[] };

type Write = (name: string, content: unknown) => Promise<string>;

async function inTempDir(run: (write: Write) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "impact-adapters-"));
	const write: Write = async (name, content) => {
		const target = join(directory, name);
		await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
		return target;
	};
	try {
		await run(write);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const moduleSource = (body: object) => `export async function loadSource() { return ${JSON.stringify(body)}; }`;

test("ticket file import keeps hierarchy, ordered approvals and provenance; undeclared sources stay unavailable", async () => {
	await inTempDir(async (write) => {
		await write("tickets.json", {
			version: 1,
			tickets: [
				{
					...story,
					startedAt: "2026-03-10T09:00:00Z",
					statusEvents: [
						{ at: "2026-03-02T09:00:00Z", status: "open" },
						{ at: "2026-03-20T09:00:00Z", status: "approved", releaseId: "R1" },
						{ at: "2026-03-25T09:00:00Z", status: "approved", releaseId: "R2" },
					],
				},
				{ id: "API-103", type: "Sub-task", parentId: "API-101", createdAt: "2026-03-03T09:00:00Z", statusEvents: [] },
			],
		});
		const bundle = await loadConfigured(await write("config.json", config));
		const [parent, child] = bundle.tickets ?? [];
		assert.equal(bundle.sourceKind, "configured");
		assert.equal(parent.status, "approved");
		assert.deepEqual(parent.approvals, [
			{ at: "2026-03-20T09:00:00Z", releaseId: "R1" },
			{ at: "2026-03-25T09:00:00Z", releaseId: "R2" },
		]);
		assert.deepEqual(parent.provenance, { source: "file:tickets", recordId: "API-101" });
		assert.deepEqual([child.parentId, child.status], ["API-101", "unknown"]);
		assert.deepEqual([bundle.commits, bundle.usage, bundle.charges], [undefined, undefined, undefined]);
		assert.deepEqual(
			bundle.coverage.filter((entry) => entry.status === "unavailable").map((entry) => entry.source),
			["commits", "usage", "charges"],
		);
		assert.deepEqual(bundle.sources?.tickets, config.sources.tickets);
	});
});

test("configured report context is optional and never filled from the synthetic profile", async () => {
	await inTempDir(async (write) => {
		const context = { owner: "Example lead", updatedAt: "2026-04-02", repositories: ["Service source history"], question: "What changed?" };
		assert.deepEqual((await loadConfigured(await write("config.json", { ...config, sources: {}, context }))).context, context);
		assert.equal((await loadConfigured(await write("config.json", { ...config, sources: {} }))).context, undefined);
	});
});

test("configured synthetic selectors cannot relabel fixture data or blend with live sources", async () => {
	await inTempDir(async (write) => {
		const fixture = loadSynthetic();
		for (const [metadata, sources] of [
			[{ ...fixture, startDate: "2027-01-01", endDate: "2027-12-31" }, { tickets: { kind: "synthetic" } }],
			[{ ...fixture, scope: "Unrelated team" }, { charges: { kind: "synthetic" } }],
			[fixture, { usage: { kind: "synthetic" }, commits: { kind: "git", path: "repo", revision: "HEAD" } }],
		] as const) {
			await assert.rejects(loadConfigured(await write("config.json", { ...metadata, version: 1, sources })));
		}
	});
});

test("declared coverage is preserved when consistent and rejected when it cannot reconcile", async () => {
	await inTempDir(async (write) => {
		await write("tickets.json", { version: 1, tickets: [story] });
		await write(
			"tickets.mjs",
			moduleSource({
				tickets: [{ id: "API-101", type: "Story", status: "open", createdAt: "2026-03-01T09:00:00Z", approvals: [], provenance: { source: "module", recordId: "API-101" } }],
				coverage: [{ source: "tickets", ...available, eligible: 2, missing: 1 }],
			}),
		);
		const partial = { ...available, status: "partial", eligible: 2, missing: 1, reason: "One ticket not exported" };
		const accepted = await loadConfigured(await write("config.json", { ...config, sources: { tickets: { kind: "file", path: "tickets.json", coverage: partial } } }));
		assert.deepEqual(
			accepted.coverage.find((entry) => entry.source === "tickets"),
			{ source: "tickets", ...partial },
		);
		for (const selector of [
			{ kind: "file", path: "tickets.json" },
			{ kind: "file", path: "tickets.json", coverage: { ...partial, extracted: 0, missing: 2 } },
			{ kind: "file", path: "tickets.json", coverage: { ...partial, missing: 0 } },
			{ kind: "file", path: "tickets.json", coverage: { ...partial, status: "available" } },
			{ kind: "module", path: "tickets.mjs" },
		]) {
			await assert.rejects(loadConfigured(await write("config.json", { ...config, sources: { tickets: selector } })), /tickets/, JSON.stringify(selector));
		}
	});
});

test("invalid ticket exports reject with the path, ticket ID and field", async () => {
	await inTempDir(async (write) => {
		const configPath = await write("config.json", config);
		await assert.rejects(loadConfigured(configPath), /tickets\.json/);
		await write("tickets.json", { version: 1, tickets: [{ ...story, statusEvents: [{ at: "2026-03-20T09:00:00Z", status: "approved" }] }] });
		await assert.rejects(loadConfigured(configPath), /API-101.*releaseId/);
		for (const [ticket, pattern] of [
			[{ ...story, createdAt: "not-a-date" }, /API-101.*createdAt/],
			[{ ...story, startedAt: "2026-03-10T09:00:00Z", statusEvents: [{ at: "2026-03-09T09:00:00Z", status: "approved", releaseId: "R1" }] }, /API-101.*startedAt/],
		] as const) {
			await assert.rejects(loadTicketFile(await write("tickets.json", { version: 1, tickets: [ticket] })), pattern);
		}
	});
});

test("trusted module receives config and returns validated partial coverage without synthetic fill", async () => {
	await inTempDir(async (write) => {
		await write(
			"adapter.mjs",
			`export async function loadSource(config) {
      return { tickets: [{ id: 'API-900', type: 'Story', status: 'open', createdAt: '2026-03-02T09:00:00Z', approvals: [],
        provenance: { source: config.scope, recordId: 'API-900' } }],
        coverage: [{ source: 'tickets', status: 'partial', eligible: 2, extracted: 1, linked: 0, excluded: 0, missing: 1, reason: 'Gap' }] };
    }`,
		);
		const bundle = await loadConfigured(await write("config.json", { ...config, sources: { tickets: { kind: "module", path: "adapter.mjs" } } }));
		const coverage = bundle.coverage.find((entry) => entry.source === "tickets");
		assert.equal(bundle.tickets?.[0].provenance.source, "Example API team");
		assert.deepEqual([coverage?.status, coverage?.missing], ["partial", 1]);
		assert.deepEqual([bundle.usage, bundle.charges], [undefined, undefined]);
		assert.deepEqual(bundle.sources?.tickets, { kind: "module", path: "adapter.mjs" });
	});
});

test("module records get the same record and coverage validation as file imports", async () => {
	await inTempDir(async (write) => {
		const examples = {
			tickets: { id: "API-901", type: "Story", status: "open", createdAt: "2026-03-02T09:00:00Z", approvals: [], provenance: { source: "custom", recordId: "API-901" } },
			commits: { hash: "abc123", parents: [], at: "2026-03-02T09:00:00Z", paths: [], bot: false, ticketIds: [], provenance: { source: "custom", recordId: "abc123" } },
			usage: {
				id: "U-1",
				at: "2026-03-02T09:00:00Z",
				model: "example",
				inputTokens: 1,
				cachedInputTokens: 0,
				outputTokens: 1,
				attempt: 1,
				outcome: "success",
				provenance: { source: "custom", recordId: "U-1" },
			},
			charges: {
				id: "C-1",
				billId: "B-1",
				billTotal: 1,
				allocatedTo: "Example API team",
				month: "2026-03",
				currency: "EUR",
				category: "consumption",
				amount: 1,
				allocationKey: "example",
				provenance: { source: "custom", recordId: "C-1" },
			},
		};
		const cases: [string, object, RegExp][] = [
			["usage", { usage: [{ ...examples.usage, id: "bad-event", cachedInputTokens: 2 }], coverage: [{ source: "usage", ...available }] }, /usage bad-event: cachedInputTokens/],
			["tickets", { tickets: [examples.tickets] }, /tickets.*coverage/],
			...(["tickets", "commits", "usage", "charges"] as const).map((source): [string, object, RegExp] => [
				source,
				{ [source]: [examples[source]], coverage: [{ source, ...available, status: "partial", extracted: 0, missing: 1, reason: "Gap" }] },
				new RegExp(`${source}.*extracted`),
			]),
		];
		for (const [index, [source, body, pattern]] of cases.entries()) {
			const moduleName = `module-${index}.mjs`;
			await write(moduleName, moduleSource(body));
			await assert.rejects(loadConfigured(await write("config.json", { ...config, sources: { [source]: { kind: "module", path: moduleName } } })), pattern);
		}
	});
});

test("structured usage and billing retain retries and bill allocation fields", async () => {
	await inTempDir(async (write) => {
		await write("usage.json", {
			version: 1,
			usage: [
				{ id: "attempt-1", at: "2026-03-18T10:00:00Z", model: "example-model", inputTokens: 100, cachedInputTokens: 40, outputTokens: 0, attempt: 1, outcome: "failed" },
				{ id: "attempt-2", at: "2026-03-18T10:01:00Z", model: "example-model", inputTokens: 80, cachedInputTokens: 20, outputTokens: 20, attempt: 2, outcome: "success" },
			],
		});
		await write("billing.json", {
			version: 1,
			charges: [
				{
					id: "C-1",
					billId: "B-1",
					billTotal: 50,
					allocatedTo: "Example API team",
					month: "2026-03",
					currency: "EUR",
					category: "consumption",
					amount: 50,
					allocationKey: "api-team",
				},
			],
		});
		const bundle = await loadConfigured(
			await write("config.json", {
				...config,
				sources: {
					usage: { kind: "file", path: "usage.json", coverage: { ...available, eligible: 2, extracted: 2 } },
					charges: { kind: "file", path: "billing.json", coverage: available },
				},
			}),
		);
		assert.deepEqual(
			bundle.usage?.filter((event): event is UsageEvent => !isMonthlyUsage(event)).map((event) => [event.id, event.outcome, event.cachedInputTokens]),
			[
				["attempt-1", "failed", 40],
				["attempt-2", "success", 20],
			],
		);
		assert.deepEqual(
			bundle.charges?.map((charge) => [charge.billId, charge.billTotal, charge.allocatedTo]),
			[["B-1", 50, "Example API team"]],
		);
		assert.equal(bundle.coverage.find((entry) => entry.source === "tickets")?.status, "unavailable");
	});
});

test("monthly token totals import without event details and reject mixed or detailed records", async () => {
	await inTempDir(async (write) => {
		const record = { kind: "monthly-total", id: "march-total", month: "2026-03", tokens: 12_000_000 };
		const source = { kind: "file", path: "usage.json", coverage: available };
		await write("usage.json", { version: 1, usage: [record] });
		const configPath = await write("config.json", { ...config, sources: { usage: source } });
		assert.deepEqual((await loadConfigured(configPath)).usage, [{ ...record, provenance: { source: "file:usage", recordId: "march-total" } }]);
		await write("usage.json", { version: 1, usage: [{ ...record, model: "invented-model", ticketId: "API-101" }] });
		await assert.rejects(loadConfigured(configPath), /monthly/);
		const event = { id: "event", at: "2026-03-18T10:00:00Z", model: "model-a", inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, attempt: 1, outcome: "success" };
		await write("usage.json", { version: 1, usage: [record, event] });
		await assert.rejects(
			loadConfigured(await write("config.json", { ...config, sources: { usage: { ...source, coverage: { ...available, eligible: 2, extracted: 2 } } } })),
			/usage/,
		);
	});
});

test("Git selector rejects a missing repository instead of borrowing synthetic commits", async () => {
	await inTempDir(async (write) => {
		await assert.rejects(loadConfigured(await write("config.json", { ...config, sources: { commits: { kind: "git", path: "repo", revision: "HEAD" } } })), /commits/);
	});
});

test("shipped ticket and module examples load from their versioned configs", async () => {
	const examples = fileURLToPath(new URL("../../examples/", import.meta.url));
	const ticketBundle = await loadConfigured(join(examples, "config.json"));
	assert.equal(ticketBundle.tickets?.find((ticket) => ticket.id === "API-103")?.parentId, "API-101");
	assert.deepEqual(
		ticketBundle.tickets?.find((ticket) => ticket.id === "API-101")?.approvals.map((event) => event.releaseId),
		["EXAMPLE-R1", "EXAMPLE-R2"],
	);
	assert.equal(ticketBundle.usage, undefined);
	const moduleBundle = await loadConfigured(join(examples, "module-config.json"));
	assert.equal(moduleBundle.tickets?.[0].id, "API-901");
	assert.equal(moduleBundle.charges, undefined);
});
