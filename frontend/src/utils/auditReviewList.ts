/** The Audit Review list: one row per dataset with its check results, the tabs (each a fixed
 * filter on the same rows) and the filters, kept in the URL. */

import type { AuditDataset } from "../hooks/useAuditDatasets";
import type { EvaluationDecision, GeorefStatus, IAuditDatasetResult, ReviewItem } from "../types/auditChecks";
import { REVIEW_ITEMS, majorShare } from "./auditReview";

export interface IAuditListRow {
	id: number;
	dataset: AuditDataset;
	/** the dataset's row of audit.dataset_outcomes; null when the view has none or can't be read */
	result: IAuditDatasetResult | null;
	/** who answered on the dataset on this page (emails, else user ids) */
	reviewers: string[];
	/** user reports, open or acknowledged */
	flags: number;
	/** suggested polygon edits waiting for a decision */
	edits: number;
	/** selected as reference data: the segmentation benchmark (reference patches) */
	reference: boolean;
}

export type AuditListTab = "all" | "pending" | "benchmark" | "edits-flags" | "reference";

/** Each tab is the whole list with one fixed chip; "all" has none. The Audit Review's tabs come
 * first; the other group holds lists that are not part of the audit. */
export const TABS: { key: AuditListTab; group: "review" | "other"; label: string; chip: string | null; test: (row: IAuditListRow) => boolean }[] = [
	{ key: "all", group: "review", label: "All audits", chip: null, test: () => true },
	{ key: "pending", group: "review", label: "Pending audit reviews", chip: "Review required", test: (r) => !!r.result?.review_required.length },
	// the benchmark tab shows the benchmarks themselves, not datasets: no count
	{ key: "benchmark", group: "review", label: "Benchmark", chip: null, test: () => false },
	{ key: "edits-flags", group: "other", label: "Edits & flags", chip: "Edits or user reports", test: (r) => r.flags > 0 || r.edits > 0 },
	{ key: "reference", group: "other", label: "Segmentation Benchmark", chip: "Segmentation benchmark", test: (r) => r.reference },
];

export const tabOf = (key: string | null): AuditListTab => TABS.find((t) => t.key === key)?.key ?? "all";

export interface IAuditListFilters {
	id: string;
	country: string | null;
	/** "finished", "unfinished" or a processing status, e.g. "deadwood_segmentation" */
	stage: string | null;
	decision: EvaluationDecision | "none" | null;
	georef: GeorefStatus | "none" | null;
	dateReplaced: "yes" | "no" | null;
	/** the least share of major crops (0 to 100) on either prediction layer */
	majorShare: number | null;
	/** a review is required: for any reason, or for this one */
	review: ReviewItem | "any" | null;
	inBenchmark: boolean;
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

export const activeFilterCount = (filters: IAuditListFilters) =>
	(Object.keys(filters) as (keyof IAuditListFilters)[]).filter((key) => filters[key] !== NO_FILTERS[key]).length;

function matchesStage(row: IAuditListRow, stage: string): boolean {
	const done = row.result?.is_processing_done ?? false;
	if (stage === "finished") return done;
	if (stage === "unfinished") return !done;
	return row.result?.current_status === stage;
}

/** The rows a tab shows with the filters applied, newest dataset first. */
export function filterRows(rows: IAuditListRow[], tab: AuditListTab, f: IAuditListFilters): IAuditListRow[] {
	const fixed = TABS.find((t) => t.key === tab)!.test;
	const id = f.id.trim();
	return rows
		.filter((row) => {
			const r = row.result;
			if (!fixed(row)) return false;
			if (id && String(row.id) !== id) return false;
			if (f.country && row.dataset.admin_level_1 !== f.country) return false;
			if (f.stage && !matchesStage(row, f.stage)) return false;
			if (f.decision && (r?.evaluation_decision ?? "none") !== f.decision) return false;
			if (f.georef && (r?.georef_status ?? "none") !== f.georef) return false;
			if (f.dateReplaced && r?.date_replace !== (f.dateReplaced === "yes")) return false;
			if (f.majorShare !== null && !(r && (majorShare(r) ?? -1) >= f.majorShare)) return false;
			if (f.review === "any" && !r?.review_required.length) return false;
			if (f.review && f.review !== "any" && !r?.review_required.includes(f.review)) return false;
			if (f.inBenchmark && !r?.in_benchmark) return false;
			if (f.reviewedBy && !row.reviewers.includes(f.reviewedBy)) return false;
			return true;
		})
		.sort((a, b) => b.id - a.id);
}

/** Where Save & Next goes: the next row after this dataset in the list it was opened from, as the
 * table showed it (its tab and filters, newest first); null after the last one. The current
 * dataset need not be in the list any more: saving may have taken it out (no review left). */
export function nextInList(rows: IAuditListRow[], listPath: string, currentId: number): number | null {
	const params = new URLSearchParams(listPath.split("?")[1] ?? "");
	return filterRows(rows, tabOf(params.get("tab")), filtersFromParams(params)).find((r) => r.id < currentId)?.id ?? null;
}

/** The processing statuses in the rows (besides idle), for the stage filter. */
export const stagesOf = (rows: IAuditListRow[]) =>
	[...new Set(rows.map((r) => r.result?.current_status).filter((s): s is string => !!s && s !== "idle"))].sort();
