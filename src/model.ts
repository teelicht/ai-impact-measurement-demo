export interface Coverage {
	source: string;
	status: "available" | "partial" | "unavailable";
	eligible: number;
	extracted: number;
	linked: number;
	excluded: number;
	missing: number;
	reason: string;
}

export type SourceName = "tickets" | "commits" | "usage" | "charges";

export interface SourceSelector {
	kind: "synthetic" | "file" | "git" | "module";
	path?: string;
	revision?: string;
	ticketPattern?: string;
	botAuthors?: string[];
	coverage?: Omit<Coverage, "source">;
}

export interface Provenance {
	source: string;
	recordId: string;
}

export interface ReportContext {
	owner?: string;
	updatedAt?: string;
	description?: string;
	includedWork?: string;
	excludedWork?: string;
	aiUse?: string;
	concurrentChanges?: string;
	question?: string;
	controls?: string;
	resourceLimits?: string;
	repositories?: string[];
}

export interface Ticket {
	id: string;
	provenance: Provenance;
	type: string;
	status: "open" | "approved" | "unknown";
	parentId?: string;
	createdAt: string;
	startedAt?: string;
	approvals: { at: string; releaseId: string }[];
	emergency?: boolean;
	production?: boolean;
}

export interface Commit {
	hash: string;
	provenance: Provenance;
	parents: string[];
	at: string;
	paths: string[];
	bot: boolean;
	ticketIds: string[];
	linesAdded?: number;
	linesDeleted?: number;
	contributorId?: string;
	changeSize?: number;
	testLinesAdded?: number;
	sourceLinesAdded?: number;
}

export interface UsageEvent {
	kind?: never;
	id: string;
	provenance: Provenance;
	at: string;
	model: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	attempt: number;
	outcome: "success" | "failed";
	ticketId?: string;
}

export interface MonthlyUsage {
	kind: "monthly-total";
	id: string;
	provenance: Provenance;
	month: string;
	tokens: number;
}

export type UsageRecord = UsageEvent | MonthlyUsage;

export const isMonthlyUsage = (record: UsageRecord): record is MonthlyUsage => record.kind === "monthly-total";

export interface Charge {
	id: string;
	provenance: Provenance;
	billId: string;
	billTotal: number;
	allocatedTo: string;
	month: string;
	currency: string;
	category: string;
	amount: number;
	allocationKey: string;
}

export interface SourceBundle {
	scope: string;
	context?: ReportContext;
	sourceKind: "synthetic" | "configured";
	startDate: string;
	endDate: string;
	timezone: string;
	extractedAt: string;
	currency: string;
	completenessAttestation: string;
	coverage: Coverage[];
	sources?: Partial<Record<SourceName, SourceSelector>>;
	tickets?: Ticket[];
	commits?: Commit[];
	usage?: UsageRecord[];
	charges?: Charge[];
}
