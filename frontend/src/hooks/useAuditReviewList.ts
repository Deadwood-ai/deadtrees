import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { AUDIT_RESULTS_KEY, audit } from "./useAuditChecks";
import {
	COUNTED_TABS,
	LIST_COLUMNS,
	NEWEST_FIRST,
	NO_FILTERS,
	listConditions,
	listOfPath,
	listOrder,
	listParams,
	type AuditListTab,
	type IAuditListFilters,
	type IAuditListRow,
	type IListSort,
} from "../utils/auditReviewList";

/** Every query on audit.review_list; an answer refreshes them with the results, a user report
 * or an edit decision refreshes them alone. */
export const REVIEW_LIST_KEY = [...AUDIT_RESULTS_KEY, "list"];

const STALE_MS = 60 * 1000;

/** A query on audit.review_list with the tab's and the filters' conditions; null when the tab
 * lists no datasets. */
function listQuery(columns: string, tab: AuditListTab, filters: IAuditListFilters, options?: { count: "exact"; head: true }) {
	const conditions = listConditions(tab, filters);
	if (!conditions) return null;
	let query = audit().from("review_list").select(columns, options);
	for (const c of conditions) query = Array.isArray(c) ? query.filter(...c) : query.or(c.or);
	return query;
}

async function countOf(tab: AuditListTab, filters: IAuditListFilters): Promise<number> {
	const query = listQuery("dataset_id", tab, filters, { count: "exact", head: true });
	if (!query) return 0;
	// no rows: the server only counts, instead of also reading the first rows
	const { count, error } = await query.limit(0);
	if (error) throw error;
	return count ?? 0;
}

function useAuditorQuery() {
	const { user } = useAuth();
	const { canAudit } = useCanAudit();
	return !!user?.id && canAudit;
}

export interface IAuditListPage {
	rows: IAuditListRow[];
	/** the rows of the list with its filters, on every page */
	total: number;
}

/** One page of the list with its tab, filters and sort, and how many rows it has in all (auditors only). */
export function useAuditListPage(tab: AuditListTab, filters: IAuditListFilters, sort: IListSort, page: number, pageSize: number) {
	const enabled = useAuditorQuery();
	return useQuery({
		queryKey: [...REVIEW_LIST_KEY, "page", listParams(tab, filters).toString(), sort, page, pageSize],
		queryFn: async (): Promise<IAuditListPage> => {
			let query = listQuery(LIST_COLUMNS, tab, filters);
			if (!query) return { rows: [], total: 0 };
			for (const o of listOrder(sort)) query = query.order(o.column, { ascending: o.ascending, nullsFirst: o.nullsFirst });
			// the count runs beside the page, not after it
			const [{ data, error }, total] = await Promise.all([
				query.range((page - 1) * pageSize, page * pageSize - 1).overrideTypes<IAuditListRow[], { merge: false }>(),
				countOf(tab, filters),
			]);
			if (error) throw error;
			return { rows: data ?? [], total };
		},
		enabled: enabled && tab !== "benchmark",
		placeholderData: keepPreviousData,
		staleTime: STALE_MS,
	});
}

/** How many datasets each tab lists, without the filters. */
export function useAuditTabCounts() {
	const enabled = useAuditorQuery();
	return useQuery({
		queryKey: [...REVIEW_LIST_KEY, "counts"],
		queryFn: async () => {
			const counts = await Promise.all(COUNTED_TABS.map((tab) => countOf(tab, NO_FILTERS)));
			return Object.fromEntries(COUNTED_TABS.map((tab, i) => [tab, counts[i]])) as Partial<Record<AuditListTab, number>>;
		},
		enabled,
		staleTime: STALE_MS,
	});
}

export interface IAuditListOptions {
	countries: string[];
	/** processing statuses besides idle */
	stages: string[];
	reviewers: { id: string; email: string | null }[];
}

/** The filters' choices (audit.review_list_options). */
export function useAuditListOptions() {
	const enabled = useAuditorQuery();
	return useQuery({
		queryKey: [...REVIEW_LIST_KEY, "options"],
		queryFn: async () => {
			const { data, error } = await audit().rpc("review_list_options");
			if (error) throw error;
			return data as IAuditListOptions;
		},
		enabled,
		staleTime: 5 * STALE_MS,
	});
}

/** Where Save & Next goes: the next row after this dataset in the list it was opened from, with
 * its tab and filters, newest first; null after the last one. The current dataset need not be in
 * the list any more: saving may have taken it out (no review left). */
export function useNextInList(listPath: string, currentId: number) {
	const enabled = useAuditorQuery();
	const { tab, filters } = listOfPath(listPath);
	return useQuery({
		queryKey: [...REVIEW_LIST_KEY, "next", listParams(tab, filters).toString(), currentId],
		queryFn: async () => {
			const query = listQuery("dataset_id", tab, filters);
			if (!query) return null;
			const { column, ascending } = listOrder(NEWEST_FIRST)[0];
			const { data, error } = await query
				.lt(column, currentId)
				.order(column, { ascending })
				.limit(1)
				.overrideTypes<{ dataset_id: number }[], { merge: false }>();
			if (error) throw error;
			return data[0]?.dataset_id ?? null;
		},
		enabled,
	});
}
