import type { FactoryFilters, FactoryRow, FactoryState } from "./factoryTypes";

export const UNKNOWN_LABEL = "unknown";

/** A claim without any database signal for this long is flagged as silent. */
export const SILENT_CLAIM_MINUTES = 60;

const pad = (value: number) => String(value).padStart(2, "0");

/** "2026-09-21 06:58 UTC", or "unknown" when the value is missing or unparsable. */
export function formatUtc(iso: string | null | undefined): string {
	if (!iso) return UNKNOWN_LABEL;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return UNKNOWN_LABEL;
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
		date.getUTCHours()
	)}:${pad(date.getUTCMinutes())} UTC`;
}

export function minutesSince(iso: string | null | undefined, nowMs: number = Date.now()): number | null {
	if (!iso) return null;
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return null;
	return Math.round((nowMs - time) / 60_000);
}

/** Compact duration such as "45 min", "1 h 30 min" or "2 d 4 h". */
export function formatDuration(totalMinutes: number): string {
	const minutes = Math.abs(Math.round(totalMinutes));
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest ? `${hours} h ${rest} min` : `${hours} h`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** "3 min ago", "in 5 min", or "unknown". */
export function formatRelative(iso: string | null | undefined, nowMs: number = Date.now()): string {
	const minutes = minutesSince(iso, nowMs);
	if (minutes === null) return UNKNOWN_LABEL;
	if (Math.abs(minutes) < 1) return "just now";
	return minutes > 0 ? `${formatDuration(minutes)} ago` : `in ${formatDuration(minutes)}`;
}

export function isSilentClaim(lastSignalAt: string | null | undefined, nowMs: number = Date.now()): boolean {
	const minutes = minutesSince(lastSignalAt, nowMs);
	return minutes !== null && minutes >= SILENT_CLAIM_MINUTES;
}

const STATE_LABELS: Record<FactoryState, string> = {
	claimed: "Claimed",
	queued: "Queued",
	failed: "Failed",
	uncertain: "Uncertain",
	ready: "Ready",
	incomplete: "Idle, incomplete",
};

export function stateLabel(state: string | null | undefined): string {
	if (!state) return UNKNOWN_LABEL;
	return (STATE_LABELS as Record<string, string>)[state] ?? state;
}

export type FactoryTone = "processing" | "warning" | "error" | "default" | "success" | "muted";

export function stateTone(state: string | null | undefined): FactoryTone {
	switch (state) {
		case "claimed":
			return "processing";
		case "queued":
			return "warning";
		case "failed":
			return "error";
		case "uncertain":
			return "warning";
		case "ready":
			return "success";
		case "incomplete":
			return "muted";
		default:
			return "default";
	}
}

export const STATE_DESCRIPTIONS: Record<FactoryState, string> = {
	claimed: "A worker holds the queue row right now.",
	queued: "Waiting in the queue with no worker claim.",
	failed: "An error is recorded on the processing status.",
	uncertain: "Status is not idle but no queue row exists.",
	ready: "Every stage flag needed for a usable result is set.",
	incomplete: "Idle without error, but not every stage flag is set.",
};

/** Human wording for the latest notification record. */
export function notificationLabel(row: Pick<FactoryRow, "notification_state" | "notification_problem">): string {
	const state = row.notification_state;
	if (!state || state === "none") return "no record";
	return state;
}

export function publicationLabel(state: string | null | undefined): string {
	if (!state || state === "none") return "none";
	return state.replace(/_/g, " ");
}

export function intentLabel(intent: string | null | undefined): string {
	if (!intent) return UNKNOWN_LABEL;
	return intent;
}

export const ATTENTION_LABELS: Record<string, string> = {
	failed: "Failed",
	uncertain: "Uncertain",
	overdue: "Overdue",
	delivery: "Delivery problem",
	report: "Open report",
	silent: "Silent claim",
};

export const ATTENTION_DESCRIPTIONS: Record<string, string> = {
	failed: "A confirmed error with no active claim.",
	uncertain: "Status is not idle, but no queue row exists.",
	overdue: "Upload-to-result wait exceeds the documented bound for a tracked GeoTIFF under 1 GiB.",
	delivery: "A notification failed or is overdue.",
	report: "A contributor report is still open.",
	silent: "Claimed, but no database signal for over an hour. A long stage looks the same; this is not proof it is stuck.",
};

/** Names the clock behind `attention_since`; the server chooses the timestamp per reason. */
export const ATTENTION_SINCE_LABELS: Record<string, string> = {
	failed: "failed since",
	uncertain: "status updated",
	overdue: "uploaded",
	delivery: "notification recorded",
	report: "reported",
	silent: "last DB signal",
};

export function attentionLabel(reason: string | null | undefined): string {
	if (!reason) return UNKNOWN_LABEL;
	return ATTENTION_LABELS[reason] ?? reason;
}

export function attentionTone(reason: string | null | undefined): FactoryTone {
	switch (reason) {
		case "failed":
			return "error";
		case "uncertain":
		case "overdue":
		case "delivery":
		case "silent":
			return "warning";
		case "report":
			return "processing";
		default:
			return "default";
	}
}

export function formatTaskTypes(taskTypes: string[] | null | undefined): string {
	if (!taskTypes || taskTypes.length === 0) return "none recorded";
	return taskTypes.join(", ");
}

export function truncate(text: string | null | undefined, max: number): string {
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function contributorLabel(row: Pick<FactoryRow, "user_email" | "organisation" | "user_id">): string {
	const email = row.user_email || (row.user_id ? `user ${row.user_id}` : UNKNOWN_LABEL);
	return row.organisation ? `${email} (${row.organisation})` : email;
}

export function describeFilters(filters: FactoryFilters): string {
	const parts: string[] = [];
	(Object.keys(filters) as (keyof FactoryFilters)[])
		.sort()
		.forEach((key) => {
			const value = filters[key];
			if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
			parts.push(`${key}=${Array.isArray(value) ? value.join(",") : String(value)}`);
		});
	return parts.length ? parts.join(" · ") : "none";
}

export function factoryDatasetUrl(origin: string, datasetId: number): string {
	return `${origin}/factory/datasets/${datasetId}`;
}

export interface SnapshotInput {
	rows: FactoryRow[];
	asOf: string | null | undefined;
	/** First read time when the selection needed several reads. */
	asOfFirst?: string | null;
	reads?: number;
	origin: string;
	filters?: FactoryFilters;
	missingIds?: number[];
}

/**
 * Plain-text handoff. It lists recorded facts and their gaps and deliberately
 * contains no request wording, so pasting it somewhere implies no action.
 */
export function buildSnapshotText({ rows, asOf, asOfFirst, reads = 1, origin, filters, missingIds = [] }: SnapshotInput): string {
	const lines: string[] = [];
	if (reads > 1 && asOfFirst && asOfFirst !== asOf) {
		lines.push(`Factory snapshot, read-only facts, collected in ${reads} reads between ${formatUtc(asOfFirst)} and ${formatUtc(asOf)}`);
	} else if (reads > 1) {
		lines.push(`Factory snapshot, read-only facts, collected in ${reads} reads around ${formatUtc(asOf)}`);
	} else {
		lines.push(`Factory snapshot, read-only facts, taken ${formatUtc(asOf)}`);
	}
	lines.push("This text lists recorded facts only and requests no action.");
	lines.push(`Datasets: ${rows.length}${filters ? ` · filters: ${describeFilters(filters)}` : ""}`);
	if (missingIds.length) {
		lines.push(`Not returned by the Factory read model: ${missingIds.join(", ")}`);
	}

	rows.forEach((row) => {
		const unknowns: string[] = [];
		const note = (label: string, value: string | null | undefined) => {
			if (value === null || value === undefined || value === "") {
				unknowns.push(label);
				return UNKNOWN_LABEL;
			}
			return value;
		};

		lines.push("");
		lines.push(`#${row.dataset_id} · ${row.file_name || "no file name"}`);
		lines.push(`  link: ${factoryDatasetUrl(origin, row.dataset_id)}`);
		lines.push(`  contributor: ${contributorLabel(row)} · created: ${note("created_at", row.created_at ? formatUtc(row.created_at) : null)}`);
		lines.push(
			`  state: ${stateLabel(row.state)} · stage: ${note("stage", row.stage)} · intent: ${intentLabel(row.intent)}`
		);
		lines.push(
			`  worker: ${row.worker_id || "none"} · claimed: ${row.claimed_at ? formatUtc(row.claimed_at) : "none"} · queued: ${
				row.queued_at ? formatUtc(row.queued_at) : "none"
			}${row.queue_priority !== null && row.queue_priority !== undefined ? ` (priority ${row.queue_priority})` : ""} · tasks: ${formatTaskTypes(row.task_types)}`
		);
		lines.push(`  last DB signal: ${note("last_signal_at", row.last_signal_at ? formatUtc(row.last_signal_at) : null)}`);
		if (row.has_error) {
			lines.push(`  error: "${truncate(row.error_message || "error recorded without message", 300)}"`);
		}
		lines.push(
			`  delivery: ${notificationLabel(row)}${row.notification_problem ? " (problem flagged)" : ""} · publication: ${publicationLabel(
				row.publication_state
			)} · open reports: ${row.open_reports ?? 0} · audit record: ${row.has_audit ? "yes" : "no"}${
				row.archived ? " · archived" : ""
			}`
		);
		if (row.attention_reason) {
			const sinceLabel = ATTENTION_SINCE_LABELS[row.attention_reason] ?? "since";
			lines.push(
				`  attention: ${attentionLabel(row.attention_reason)} · ${sinceLabel}: ${row.attention_since ? formatUtc(row.attention_since) : "unknown"}`
			);
		}
		if (unknowns.length) {
			lines.push(`  unknown: ${unknowns.join(", ")}`);
		}
	});

	return lines.join("\n");
}
