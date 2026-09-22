import { describe, expect, it } from "vitest";
import {
	attentionLabel,
	attentionTone,
	buildSnapshotText,
	describeFilters,
	formatDuration,
	formatRelative,
	formatUtc,
	isSilentClaim,
	notificationLabel,
	stateLabel,
	truncate,
} from "./factoryFormat";
import type { FactoryRow } from "./factoryTypes";

const now = Date.UTC(2026, 8, 21, 7, 0, 0);

const row: FactoryRow = {
	dataset_id: 671,
	file_name: "forest.tif",
	created_at: "2026-09-20T10:00:00Z",
	user_id: "user-1",
	user_email: "contributor@example.com",
	organisation: "Forest Lab",
	archived: false,
	state: "failed",
	stage: "cog",
	has_error: true,
	error_message: "COG conversion failed",
	worker_id: null,
	claimed_at: null,
	queued_at: "2026-09-20T10:05:00Z",
	queue_priority: 4,
	task_types: ["geotiff", "cog"],
	last_signal_at: null,
	is_ready: false,
	upload_done: true,
	notification_state: "failed",
	notification_problem: true,
	publication_state: "none",
	open_reports: 1,
	has_audit: false,
	intent: "unknown",
};

describe("time formatting", () => {
	it("formats UTC timestamps and unknowns", () => {
		expect(formatUtc("2026-09-21T06:58:12Z")).toBe("2026-09-21 06:58 UTC");
		expect(formatUtc(null)).toBe("unknown");
		expect(formatUtc("not a date")).toBe("unknown");
	});

	it("formats relative durations", () => {
		expect(formatRelative("2026-09-21T06:57:30Z", now)).toBe("3 min ago");
		expect(formatRelative("2026-09-21T05:30:00Z", now)).toBe("1 h 30 min ago");
		expect(formatRelative("2026-09-19T03:00:00Z", now)).toBe("2 d 4 h ago");
		expect(formatRelative("2026-09-21T07:00:20Z", now)).toBe("just now");
		expect(formatRelative(null, now)).toBe("unknown");
		expect(formatDuration(0)).toBe("under a minute");
	});

	it("flags claims that have been silent for an hour", () => {
		expect(isSilentClaim("2026-09-21T05:59:00Z", now)).toBe(true);
		expect(isSilentClaim("2026-09-21T06:30:00Z", now)).toBe(false);
		expect(isSilentClaim(null, now)).toBe(false);
	});
});

describe("labels", () => {
	it("maps states and keeps unknown values visible", () => {
		expect(stateLabel("incomplete")).toBe("Idle, incomplete");
		expect(stateLabel("something_new")).toBe("something_new");
		expect(stateLabel(null)).toBe("unknown");
	});

	it("describes missing delivery records as records, not as sent or unsent", () => {
		expect(notificationLabel({ notification_state: "none", notification_problem: false })).toBe("no record");
		expect(notificationLabel({ notification_state: "sent", notification_problem: false })).toBe("sent");
	});

	it("truncates with an ellipsis and describes filters deterministically", () => {
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(describeFilters({ state: "failed", ids: [2, 1], archived: "no" })).toBe("archived=no · ids=2,1 · state=failed");
		expect(describeFilters({})).toBe("none");
	});
});

describe("buildSnapshotText", () => {
	const text = buildSnapshotText({
		rows: [row],
		asOf: "2026-09-21T06:58:00Z",
		origin: "https://deadtrees.earth",
		filters: { state: "failed" },
		missingIds: [999],
	});

	it("states facts, freshness, links and gaps", () => {
		expect(text).toContain("Factory snapshot, read-only facts, taken 2026-09-21 06:58 UTC");
		expect(text).toContain("requests no action");
		expect(text).toContain("Datasets: 1 · filters: state=failed");
		expect(text).toContain("Not returned by the Factory read model: 999");
		expect(text).toContain("#671 · forest.tif");
		expect(text).toContain("link: https://deadtrees.earth/factory/datasets/671");
		expect(text).toContain("contributor: contributor@example.com (Forest Lab)");
		expect(text).toContain("state: Failed · stage: cog · intent: unknown");
		expect(text).toContain("queued: 2026-09-20 10:05 UTC (priority 4) · tasks: geotiff, cog");
		expect(text).toContain('error: "COG conversion failed"');
		expect(text).toContain("delivery: failed (problem flagged) · publication: none · open reports: 1 · audit record: no");
		expect(text).toContain("unknown: last_signal_at");
	});

	it("reports a collection window when several reads were needed", () => {
		const multi = buildSnapshotText({
			rows: [row],
			asOf: "2026-09-21T06:59:00Z",
			asOfFirst: "2026-09-21T06:58:00Z",
			reads: 2,
			origin: "https://deadtrees.earth",
		});
		expect(multi).toContain("collected in 2 reads between 2026-09-21 06:58 UTC and 2026-09-21 06:59 UTC");
	});

	it("adds the attention reason and an explicit unknown age when ranked", () => {
		const ranked = buildSnapshotText({
			rows: [{ ...row, attention_reason: "failed", attention_since: null, attention_rank: 2 }],
			asOf: "2026-09-21T06:58:00Z",
			origin: "https://deadtrees.earth",
		});
		expect(ranked).toContain("attention: Failed · failed since: unknown");
		const silent = buildSnapshotText({
			rows: [{ ...row, attention_reason: "silent", attention_since: "2026-09-21T05:00:00Z" }],
			asOf: "2026-09-21T06:58:00Z",
			origin: "https://deadtrees.earth",
		});
		expect(silent).toContain("attention: Silent claim · last DB signal: 2026-09-21 05:00 UTC");
		expect(text).not.toContain("attention:");
	});

	it("keeps attention vocabulary stable", () => {
		expect(attentionLabel("delivery")).toBe("Delivery problem");
		expect(attentionLabel("something_new")).toBe("something_new");
		expect(attentionLabel(null)).toBe("unknown");
		expect(attentionTone("failed")).toBe("error");
		expect(attentionTone("silent")).toBe("warning");
		expect(attentionTone("report")).toBe("processing");
	});

	it("contains no request wording", () => {
		expect(text).not.toMatch(/\b(please|retry|resend|cancel|publish now|should)\b/i);
	});
});
