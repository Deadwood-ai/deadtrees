/**
 * Frontend contract for the Factory workspace RPCs.
 *
 * The SQL functions (`factory_overview`, `factory_datasets`, `factory_dataset`,
 * `factory_activity`) are owned by the database migrations. These types mirror
 * their documented shapes; the single cast from the untyped Supabase client
 * happens in `hooks/useFactory.ts`, nowhere else.
 */

export const FACTORY_STATES = [
	"claimed",
	"queued",
	"failed",
	"uncertain",
	"ready",
	"incomplete",
] as const;
export type FactoryState = (typeof FACTORY_STATES)[number];

export const FACTORY_NOTIFICATION_FILTERS = [
	"problem",
	"none",
	"sent",
	"failed",
	"pending",
	"skipped",
	"sending",
] as const;
export type FactoryNotificationFilter = (typeof FACTORY_NOTIFICATION_FILTERS)[number];

export const FACTORY_PUBLICATION_FILTERS = [
	"pending",
	"uploading",
	"in_review",
	"error",
	"declined",
	"published",
	"none",
] as const;
export type FactoryPublicationFilter = (typeof FACTORY_PUBLICATION_FILTERS)[number];

export type FactoryArchivedFilter = "all" | "yes" | "no";

export const FACTORY_ACTIVITY_KINDS = [
	"all",
	"uploads",
	"processing",
	"notifications",
	"publications",
	"reports",
] as const;
export type FactoryActivityKind = (typeof FACTORY_ACTIVITY_KINDS)[number];

export interface FactoryRow {
	dataset_id: number;
	file_name: string | null;
	created_at: string | null;
	user_id: string | null;
	user_email: string | null;
	organisation: string | null;
	archived: boolean | null;
	state: FactoryState | string | null;
	stage: string | null;
	has_error: boolean | null;
	error_message: string | null;
	worker_id: string | null;
	claimed_at: string | null;
	queued_at: string | null;
	queue_priority: number | null;
	task_types: string[] | null;
	last_signal_at: string | null;
	is_ready: boolean | null;
	upload_done: boolean | null;
	notification_state: string | null;
	notification_problem: boolean | null;
	publication_state: string | null;
	open_reports: number | null;
	has_audit: boolean | null;
	/** Server-owned purpose classification; "unknown" until durable provenance exists. */
	intent: string | null;
	/** Present when the row was ranked for attention; one primary reason per dataset. */
	attention_reason?: FactoryAttentionReason | string | null;
	attention_since?: string | null;
	attention_rank?: number | null;
}

export const FACTORY_ATTENTION_REASONS = ["failed", "uncertain", "overdue", "delivery", "report", "silent"] as const;
export type FactoryAttentionReason = (typeof FACTORY_ATTENTION_REASONS)[number];

export const FACTORY_SORTS = ["attention"] as const;
export type FactorySort = (typeof FACTORY_SORTS)[number];

export interface FactoryFilters {
	search?: string;
	state?: FactoryState;
	worker?: string;
	notification?: FactoryNotificationFilter;
	publication?: FactoryPublicationFilter;
	reports?: "open";
	contributor?: string;
	created_after?: string;
	created_before?: string;
	ids?: number[];
	archived?: FactoryArchivedFilter;
	attention?: boolean;
	uploaded?: boolean;
	has_audit?: boolean;
	ready?: boolean;
	has_error?: boolean;
	/** Ledger metric drilldowns from the overview charts; see `factory_trends`. */
	metric?: FactoryMetricFilter;
	metric_after?: string;
	metric_before?: string;
	workflow?: FactoryTrendWorkflow;
	size?: FactoryTrendSize;
	/** Server-owned ordering; newest first when absent. */
	sort?: FactorySort;
}

export const FACTORY_METRIC_FILTERS = [
	"historical_report",
	"historical_email",
	"uploaded",
	"first_ready",
	"failures",
	"first_result_failures",
	"recovered",
	"registered",
	"recorded_completed",
	"recorded_failed",
	"recorded_embedding_completed",
	"waiting",
	"failed_submission",
	"overdue",
	"unresolved_failure",
] as const;
export type FactoryMetricFilter = (typeof FACTORY_METRIC_FILTERS)[number];

export const FACTORY_TREND_WORKFLOWS = ["all", "geotiff", "odm"] as const;
export type FactoryTrendWorkflow = (typeof FACTORY_TREND_WORKFLOWS)[number];

export const FACTORY_TREND_SIZES = ["all", "small", "large", "unknown"] as const;
export type FactoryTrendSize = (typeof FACTORY_TREND_SIZES)[number];

export interface FactoryOverviewCounts {
	uncertain: number | null;
	publication_pending: number | null;
}

export interface FactoryWorker {
	worker_id: string | null;
	dataset_id: number | null;
	claimed_at: string | null;
	task_types: string[] | null;
	last_signal_at: string | null;
}

export interface FactoryOverview {
	as_of: string | null;
	since: string | null;
	counts: FactoryOverviewCounts;
	workers: FactoryWorker[];
	coverage: string[];
}

export interface FactoryDatasetsPage {
	as_of: string | null;
	/** null when the read model did not report a total. */
	total: number | null;
	items: FactoryRow[];
}

export type FactoryRecord = Record<string, unknown>;

export interface FactoryLog {
	id: number;
	created_at: string | null;
	level: string | null;
	category: string | null;
	message: string | null;
}

export interface FactoryNotification {
	id: string | number;
	event_type: string | null;
	status: string | null;
	recipient_roles: string[] | null;
	delivery_attempts: number | null;
	next_attempt_at: string | null;
	sent_at: string | null;
	created_at: string | null;
	delivery_error: string | null;
}

export interface FactoryPublication {
	id: string | number;
	status: string | null;
	doi: string | null;
	created_at: string | null;
	published_at: string | null;
}

export interface FactoryReport {
	id: string | number;
	flag_type: string | null;
	status: string | null;
	created_at: string | null;
	updated_at?: string | null;
	description: string | null;
	auditor_comment?: string | null;
}

export interface FactoryDatasetDetail {
	as_of: string | null;
	dataset: FactoryRow;
	/** Full processing status row; keys follow the database table. */
	status: FactoryRecord;
	queue: FactoryRecord[];
	/** Newest entries only; `log_total` says how many exist. */
	logs: FactoryLog[];
	log_total: number | null;
	/** Counts before the per-section 200-row history limit. */
	record_totals: Record<string, number>;
	outputs: {
		orthos: FactoryRecord[];
		cogs: FactoryRecord[];
		thumbnails: FactoryRecord[];
		raw_images: FactoryRecord[];
	};
	notifications: FactoryNotification[];
	publications: FactoryPublication[];
	reports: FactoryReport[];
	audits: FactoryRecord[];
	/** Newest entries only; `correction_total` says how many exist. */
	corrections: FactoryRecord[];
	correction_total: number | null;
	/** Failure episodes from the ledger and reconstructed from processor logs, newest first. */
	failures: FactoryRecord[];
}

export interface FactoryActivityItem {
	kind: string;
	id: string | number;
	dataset_id: number | null;
	created_at: string | null;
	state: string | null;
	summary: string | null;
}

export interface FactoryActivityPage {
	as_of: string | null;
	total: number | null;
	items: FactoryActivityItem[];
}

export const FACTORY_TREND_INTERVALS = ["week", "day", "month"] as const;
export type FactoryTrendInterval = (typeof FACTORY_TREND_INTERVALS)[number];

/** Current state of the filtered upload population, independent of the plotted window. */
export interface FactoryTrendSummary {
	/** Unarchived uploads without a first complete result that are not complete now. */
	waiting: number | null;
	waiting_failed: number | null;
	waiting_contributors: number | null;
	oldest_wait_hours: number | null;
	/** Distinct unarchived datasets whose failure episode is still open. */
	unresolved_failures: number | null;
	unresolved_first_result: number | null;
	oldest_unresolved_hours: number | null;
	/** Complete now, but no retained evidence of when the first result arrived. */
	unrecorded_results: number | null;
}

/**
 * One calendar bucket, by event time. Counts are null before the first retained
 * evidence; `*_measured` is the directly measured part, the rest is reconstructed
 * from retained upload and processor logs.
 */
export interface FactoryTrendPoint {
	start: string;
	end: string;
	partial: boolean;
	uploaded: number | null;
	uploaded_measured: number | null;
	first_ready: number | null;
	first_ready_measured: number | null;
	lead_p50_hours: number | null;
	lead_p90_hours: number | null;
	completed_input_gib: number | null;
	volume_samples: number | null;
	failures_first_result: number | null;
	failures_other: number | null;
	failures_measured: number | null;
	recovered: number | null;
	recovered_measured: number | null;
	recovery_p50_hours: number | null;
	recovery_p90_hours: number | null;
	recovery_samples: number | null;
}

export interface FactoryTrends {
	as_of: string | null;
	/** Upload and first-result measurement start (new registrations only). */
	tracking_since: string | null;
	/** Failure and recovery measurement start for every dataset. */
	failures_tracking_since: string | null;
	/** Earliest retained upload evidence and processor run; earlier periods are unknown. */
	upload_since: string | null;
	run_since: string | null;
	interval: FactoryTrendInterval;
	workflow: FactoryTrendWorkflow;
	size: FactoryTrendSize;
	summary: FactoryTrendSummary | null;
	series: FactoryTrendPoint[];
	coverage: string[];
}

/** Current unarchived dataset stock at each pipeline stage. */
export interface FactoryJourneyPipeline {
	uploaded: number | null;
	queued: number | null;
	processing: number | null;
	ready: number | null;
	failed: number | null;
	audited: number | null;
	published: number | null;
}

/** Global weekly journey counts; null means not tracked yet, never zero. */
export interface FactoryJourneyWeek {
	start: string;
	end: string;
	partial: boolean;
	uploads: number | null;
	first_ready: number | null;
	observed_views: number | null;
	publications: number | null;
}

/** First-ever tracked contributors by week of first upload, with elapsed-window outcomes. */
export interface FactoryJourneyCohort {
	week: string;
	contributors: number | null;
	activated_7d: number | null;
	activation_eligible: number | null;
	returned_30d: number | null;
	retention_eligible: number | null;
}

export interface FactoryJourney {
	as_of: string | null;
	tracking_since: string | null;
	activation_tracking_since: string | null;
	pipeline: FactoryJourneyPipeline | null;
	weekly: FactoryJourneyWeek[];
	cohorts: FactoryJourneyCohort[];
	coverage: string[];
}

export const FACTORY_WAITING_KEYS = ["queued", "processing", "failed", "delivery", "reports"] as const;
export type FactoryWaitingKey = (typeof FACTORY_WAITING_KEYS)[number];

export interface FactoryWaitingRow {
	key: FactoryWaitingKey | string;
	count: number | null;
	oldest_at: string | null;
	/** Names the exact clock behind `oldest_at`, for example "Oldest queue entry". */
	age_label: string | null;
	filters: Record<string, unknown> | null;
}

export interface FactoryOperations {
	as_of: string | null;
	attention_total: number | null;
	attention_contributors: number | null;
	attention: FactoryRow[];
	waiting: FactoryWaitingRow[];
	coverage: string[];
}
