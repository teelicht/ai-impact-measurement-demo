import { readFile } from "node:fs/promises";
import type { Charge, Ticket, UsageRecord } from "../model.js";
import { timestamp } from "../validate.js";

function object(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label}: must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label}: must be a nonempty string`);
	}
	return value;
}

function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label}: must be a finite number`);
	}
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : string(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") {
		throw new Error(`${label}: must be boolean`);
	}
	return value;
}

async function records(path: string, source: "tickets" | "usage" | "charges"): Promise<unknown[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`${source} ${path}: cannot read JSON: ${String(error)}`);
	}
	const data = object(raw, `${source} ${path}`);
	if (data.version !== 1 || !Array.isArray(data[source])) {
		throw new Error(`${source} ${path}: expected version 1 with ${source} array`);
	}
	return data[source];
}

export async function loadTicketFile(path: string): Promise<Ticket[]> {
	const tickets = await records(path, "tickets");
	return tickets.map((value) => {
		const item = object(value, `tickets ${path}: record`);
		const id = string(item.id, `tickets ${path}: id`);
		const label = `tickets ${path} ${id}`;
		if (!Array.isArray(item.statusEvents)) {
			throw new Error(`${label}: statusEvents must be an array`);
		}
		const approvals: Ticket["approvals"] = [];
		let status: Ticket["status"] = "unknown";
		const createdAt = timestamp(item.createdAt, `${label}: createdAt`);
		let previousAt = Date.parse(createdAt);
		let startedAt: string | undefined;
		if (item.startedAt !== undefined) {
			startedAt = timestamp(item.startedAt, `${label}: startedAt`);
			if (Date.parse(startedAt) < previousAt) {
				throw new Error(`${label}: startedAt precedes createdAt`);
			}
		}
		for (const [index, value] of item.statusEvents.entries()) {
			const event = object(value, `${label}: statusEvents[${index}]`);
			const at = timestamp(event.at, `${label}: statusEvents[${index}].at`);
			if (Date.parse(at) < previousAt) {
				throw new Error(`${label}: statusEvents must follow work events in order`);
			}
			previousAt = Date.parse(at);
			if (event.status !== "open" && event.status !== "approved") {
				throw new Error(`${label}: statusEvents[${index}].status must be open or approved`);
			}
			if (event.status === "approved") {
				if (startedAt !== undefined && Date.parse(at) < Date.parse(startedAt)) {
					throw new Error(`${label}: approval precedes startedAt`);
				}
				approvals.push({ at, releaseId: string(event.releaseId, `${label}: statusEvents[${index}].releaseId`) });
			} else if (event.releaseId !== undefined) {
				throw new Error(`${label}: only approval events may name a releaseId`);
			}
			status = event.status;
		}
		if (approvals.length > 0 && status !== "approved") {
			throw new Error(`${label}: open status cannot follow approval evidence`);
		}
		return {
			id,
			type: string(item.type, `${label}: type`),
			status,
			createdAt,
			...(startedAt !== undefined && { startedAt }),
			...(item.parentId !== undefined && { parentId: string(item.parentId, `${label}: parentId`) }),
			...(item.emergency !== undefined && { emergency: optionalBoolean(item.emergency, `${label}: emergency`) }),
			...(item.production !== undefined && { production: optionalBoolean(item.production, `${label}: production`) }),
			approvals,
			provenance: { source: "file:tickets", recordId: id },
		};
	});
}

export async function loadUsageFile(path: string): Promise<UsageRecord[]> {
	const usage = await records(path, "usage");
	return usage.map((value) => {
		const item = object(value, `usage ${path}: record`);
		const id = string(item.id, `usage ${path}: id`);
		const label = `usage ${path} ${id}`;
		if (item.kind === "monthly-total") {
			if (["model", "at", "inputTokens", "outputTokens", "cachedInputTokens", "attempt", "outcome", "ticketId"].some((field) => field in item))
				throw new Error(`${label}: monthly totals cannot contain event detail`);
			return {
				kind: "monthly-total",
				id,
				provenance: { source: "file:usage", recordId: id },
				month: string(item.month, `${label}: month`),
				tokens: number(item.tokens, `${label}: tokens`),
			};
		}
		if (item.kind !== undefined) throw new Error(`${label}: unsupported usage kind`);
		const outcome = string(item.outcome, `${label}: outcome`);
		if (outcome !== "success" && outcome !== "failed") {
			throw new Error(`${label}: outcome must be success or failed`);
		}
		return {
			id,
			provenance: { source: "file:usage", recordId: id },
			at: string(item.at, `${label}: at`),
			model: string(item.model, `${label}: model`),
			inputTokens: number(item.inputTokens, `${label}: inputTokens`),
			cachedInputTokens: number(item.cachedInputTokens, `${label}: cachedInputTokens`),
			outputTokens: number(item.outputTokens, `${label}: outputTokens`),
			attempt: number(item.attempt, `${label}: attempt`),
			outcome,
			...(item.ticketId !== undefined && { ticketId: optionalString(item.ticketId, `${label}: ticketId`) }),
		};
	});
}

export async function loadChargeFile(path: string): Promise<Charge[]> {
	const charges = await records(path, "charges");
	return charges.map((value) => {
		const item = object(value, `charges ${path}: record`);
		const id = string(item.id, `charges ${path}: id`);
		const label = `charges ${path} ${id}`;
		return {
			id,
			provenance: { source: "file:charges", recordId: id },
			billId: string(item.billId, `${label}: billId`),
			billTotal: number(item.billTotal, `${label}: billTotal`),
			allocatedTo: string(item.allocatedTo, `${label}: allocatedTo`),
			month: string(item.month, `${label}: month`),
			currency: string(item.currency, `${label}: currency`),
			category: string(item.category, `${label}: category`),
			amount: number(item.amount, `${label}: amount`),
			allocationKey: string(item.allocationKey, `${label}: allocationKey`),
		};
	});
}
