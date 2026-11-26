/** The Audit Review list: one row per dataset of audit.review_list, the tabs (each a fixed
 * filter on the same rows) and the filters, kept in the URL. The server pages, filters and
 * sorts: the tab, the filters and the sort become PostgREST conditions here. */

import type { EvaluationDecision, GeorefStatus, IAuditDatasetResult, ReviewItem } from "../types/auditChecks";
import { REVIEW_ITEMS } from "./auditReview";

/** A processing stage: its done flag and the status while it runs (v2_status). */
export const PROCESSING_STAGES = [
	{ label: "Upload", done: "is_upload_done", status: "uploading" },
	{ label: "ODM", done: "is_odm_done", status: "odm_processing" },
	{ label: "Ortho", done: "is_ortho_done", status: "ortho_processing" },
	{ label: "Metadata", done: "is_metadata_done", status: "metadata_processing" },
	{ label: "COG", done: "is_cog_done", status: "cog_processing" },
	{ label: "Thumbnail", done: "is_thumbnail_done", status: "thumbnail_processing" },
	{ label: "Deadwood (v1)", done: "is_deadwood_done", status: "deadwood_segmentation" },
	{ label: "Tree cover (v1)", done: "is_forest_cover_done", status: "forest_cover_segmentation" },
	{ label: "Combined model", done: "is_combined_model_done", status: "deadwood_treecover_combined_segmentation" },
	{ label: "AOI", done: "is_aoi_done", status: "aoi_segmentation" },
	{ label: "Embeddings", done: "is_embeddings_done", status: "embedding_processing" },
	{ label: "Date estimate", done: "is_doy_estimation_done", status: "doy_estimation" },
	{ label: "Georef check", done: "is_georef_check_done", status: "georef_check" },
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];
export type StageState = "succeeded" | "failed" | "running" | "not_run";

/** One row of audit.review_list as the table reads it. */
export interface IAuditListRow extends Record<ProcessingStage["done"], boolean> {
	dataset_id: number;
	aquisition_year: number | null;
	aquisition_month: number | null;
	aquisition_day: number | null;
	admin_level_1: string | null;
	admin_level_3: string | null;
	has_ml_tiles: boolean;
	/** the dataset's row of audit.dataset_outcomes */
	result: IAuditDatasetResult | null;
	current_status: string | null;
	has_error: boolean;
	/** the stage that failed (a v2_status name, "unknown" when not recorded) */
	failed_stage: string | null;
	error_message: string | null;
	/** user reports, open or acknowledged */
	flags: number;
	/** suggested polygon edits waiting for a decision */
	edits: number;
	/** selected as reference data: the segmentation benchmark (reference patches) */
	reference: boolean;
}

export const LIST_COLUMNS = [
	"dataset_id",
	"aquisition_year",
	"aquisition_month",
	"aquisition_day",
	"admin_level_1",
	"admin_level_3",
	"has_ml_tiles",
	"result:outcome",
	"current_status",
	...PROCESSING_STAGES.map((s) => s.done),
	"has_error",
	"failed_stage",
	"error_message",
	"flags",
	"edits",
	"reference",
].join(",");

/** A stage of a row: running, failed there, done, or not run. */
export function stageState(row: IAuditListRow, stage: ProcessingStage): StageState {
	if (row.current_status === stage.status) return "running";
	if (row.has_error && row.failed_stage === stage.status) return "failed";
	return row[stage.done] ? "succeeded" : "not_run";
}

/** A PostgREST condition: [column, operator, value], or several joined by or. */
export type ListCondition = [column: string, operator: string, value: string] | { or: string };

export type AuditListTab = "all" | "pending" | "benchmark" | "edits-flags" | "reference";

/** Each tab is the whole list with one fixed chip; "all" has none. The Audit Review's tabs come
 * first; the other group holds lists that are not part of the audit. `where` is the tab's
 * condition; null for a tab that lists no datasets. */
export const TABS: { key: AuditListTab; group: "review" | "other"; label: string; chip: string | null; where: ListCondition[] | null }[] = [
	{ key: "all", group: "review", label: "All audits", chip: null, where: [] },
	{ key: "pending", group: "review", label: "Pending audit reviews", chip: "Review required", where: [["review_required", "neq", "{}"]] },
	// the benchmark tab shows the benchmarks themselves, not datasets
	{ key: "benchmark", group: "review", label: "Benchmark", chip: null, where: null },
	{ key: "edits-flags", group: "other", label: "Edits & flags", chip: "Edits or user reports", where: [{ or: "flags.gt.0,edits.gt.0" }] },
	{ key: "reference", group: "other", label: "Segmentation Benchmark", chip: "Segmentation benchmark", where: [["reference", "is", "true"]] },
];

/** The tabs that list datasets: each has a count. */
export const COUNTED_TABS = TABS.filter((t) => t.where !== null).map((t) => t.key);

export const tabOf = (key: string | null): AuditListTab => TABS.find((t) => t.key === key)?.key ?? "all";

export interface IAuditListFilters {
	id: string;
	country: string | null;
	/** "finished", "unfinished", "failed" or a processing status, e.g. "deadwood_segmentation" */
	stage: string | null;
	decision: EvaluationDecision | "none" | null;
	georef: GeorefStatus | "none" | null;
	dateReplaced: "yes" | "no" | null;
	/** the least share of major crops (0 to 100) on either prediction layer */
	majorShare: number | null;
	/** a review is required: for any reason, or for this one */
	review: ReviewItem | "any" | null;
	inBenchmark: boolean;
	/** a reviewer's user id */
	reviewedBy: string | null;
}

export const NO_FILTERS: IAuditListFilters = {
	id: "",
	country: null,
	stage: null,
	decision: null,
	georef: null,
	dateReplaced: null,
	majorShare: null,
	review: null,
	inBenchmark: false,
	reviewedBy: null,
};

/** Each filter's URL parameter. */
const PARAMS: Record<keyof IAuditListFilters, string> = {
	id: "id",
	country: "country",
	stage: "stage",
	decision: "decision",
	georef: "georef",
	dateReplaced: "date",
	majorShare: "major",
	review: "review",
	inBenchmark: "benchmark",
	reviewedBy: "reviewer",
};

export function filtersFromParams(params: URLSearchParams): IAuditListFilters {
	const get = (key: keyof IAuditListFilters) => params.get(PARAMS[key]);
	const major = Number(get("majorShare"));
	const review = get("review");
	return {
		id: get("id") ?? "",
		country: get("country"),
		stage: get("stage"),
		decision: get("decision") as IAuditListFilters["decision"],
		georef: get("georef") as IAuditListFilters["georef"],
		dateReplaced: get("dateReplaced") === "yes" || get("dateReplaced") === "no" ? (get("dateReplaced") as "yes" | "no") : null,
		majorShare: get("majorShare") !== null && Number.isFinite(major) ? major : null,
		review: review === "any" || REVIEW_ITEMS.includes(review as ReviewItem) ? (review as IAuditListFilters["review"]) : null,
		inBenchmark: get("inBenchmark") === "1",
		reviewedBy: get("reviewedBy"),
	};
}

/** The tab and the filters that are set, as URL parameters. */
export function listParams(tab: AuditListTab, filters: IAuditListFilters): URLSearchParams {
	const params = new URLSearchParams({ tab });
	for (const [key, value] of Object.entries(filters) as [keyof IAuditListFilters, IAuditListFilters[keyof IAuditListFilters]][]) {
		if (value === null || value === "" || value === false) continue;
		params.set(PARAMS[key], value === true ? "1" : String(value));
	}
	return params;
}

/** The tab and filters of a list path, e.g. "/dataset-audit?tab=pending&country=Spain". */
export function listOfPath(listPath: string): { tab: AuditListTab; filters: IAuditListFilters } {
	const params = new URLSearchParams(listPath.split("?")[1] ?? "");
	return { tab: tabOf(params.get("tab")), filters: filtersFromParams(params) };
}

export const activeFilterCount = (filters: IAuditListFilters) =>
	(Object.keys(filters) as (keyof IAuditListFilters)[]).filter((key) => filters[key] !== NO_FILTERS[key]).length;

/** The processing filter's choices besides the statuses. Not finished leaves out the failed ones. */
const STAGE_CONDITIONS: Record<string, ListCondition[]> = {
	finished: [["is_processing_done", "is", "true"]],
	unfinished: [
		["is_processing_done", "is", "false"],
		["has_error", "is", "false"],
	],
	failed: [["has_error", "is", "true"]],
};

const valueOrNone = (column: string, value: string): ListCondition => (value === "none" ? [column, "is", "null"] : [column, "eq", value]);

/** The conditions of a tab with the filters; null when the tab lists no datasets. */
export function listConditions(tab: AuditListTab, f: IAuditListFilters): ListCondition[] | null {
	const fixed = TABS.find((t) => t.key === tab)!.where;
	if (!fixed) return null;
	const id = f.id.trim();
	const conditions: (ListCondition | false)[] = [
		...fixed,
		// not a number: no dataset has that id
		!!id && ["dataset_id", "eq", /^\d+$/.test(id) ? id : "0"],
		!!f.country && ["admin_level_1", "eq", f.country],
		...(f.stage ? (STAGE_CONDITIONS[f.stage] ?? [["current_status", "eq", f.stage] as ListCondition]) : []),
		!!f.decision && valueOrNone("evaluation_decision", f.decision),
		!!f.georef && valueOrNone("georef_status", f.georef),
		!!f.dateReplaced && ["date_replace", "is", f.dateReplaced === "yes" ? "true" : "false"],
		f.majorShare !== null && ["major_share", "gte", String(f.majorShare)],
		f.review === "any" ? ["review_required", "neq", "{}"] : !!f.review && ["review_required", "cs", `{${f.review}}`],
		f.inBenchmark && ["in_benchmark", "is", "true"],
		!!f.reviewedBy && ["reviewers", "cs", `{${f.reviewedBy}}`],
	];
	return conditions.filter((c): c is ListCondition => !!c);
}

export interface IListSort {
	/** the key of a sortable table column */
	key: string;
	ascending: boolean;
}

/** Newest dataset first: the list's order, and Save & Next's. */
export const NEWEST_FIRST: IListSort = { key: "id", ascending: false };

/** The view's columns each sortable table column orders by. */
const SORT_COLUMNS: Record<string, string[]> = {
	id: ["dataset_id"],
	location: ["admin_level_3", "admin_level_1"],
	date: ["aquisition_year", "aquisition_month", "aquisition_day"],
	evaluation: ["evaluation_decision"],
	georef: ["georef_offset_m"],
	phenology: ["phenology_probability"],
	forest: ["forest_cover_major_share"],
	deadwood: ["deadwood_major_share"],
};

export const isSortable = (key: string) => key in SORT_COLUMNS;

const BY_ID = { column: "dataset_id", ascending: false };

/** The order of a sort: a missing value is the smallest, ties go newest first. The id is never
 * missing and keeps the database's own order, so the newest rows come straight from its index. */
export function listOrder({ key, ascending }: IListSort): { column: string; ascending: boolean; nullsFirst?: boolean }[] {
	if (!(key in SORT_COLUMNS) || key === "id") return [{ ...BY_ID, ascending: key === "id" && ascending }];
	return [...SORT_COLUMNS[key].map((column) => ({ column, ascending, nullsFirst: ascending })), BY_ID];
}
