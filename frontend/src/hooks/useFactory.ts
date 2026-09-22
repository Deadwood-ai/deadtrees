import type { FactoryHistory } from "../components/Factory/factoryHistoryTypes";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanOperate } from "./useUserPrivileges";
import { FACTORY_MAX_RPC_LIMIT, toRpcFilters } from "../components/Factory/factoryFilters";
import type {
	FactoryActivityKind,
	FactoryActivityPage,
	FactoryDatasetDetail,
	FactoryDatasetsPage,
	FactoryFilters,
	FactoryJourney,
	FactoryOperations,
	FactoryOverview,
	FactoryRecord,
	FactoryRow,
	FactoryTrendInterval,
	FactoryTrendSize,
	FactoryTrendWorkflow,
	FactoryTrends,
} from "../components/Factory/factoryTypes";

/**
 * Boundary between the untyped Supabase client and the Factory contract.
 * Every RPC result is cast exactly once here and normalised so the UI never
 * has to guard against missing arrays or objects.
 */

const PERMISSION_ERROR_CODE = "42501";

export function isFactoryPermissionError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (code === PERMISSION_ERROR_CODE) return true;
	return typeof message === "string" && /operator permission/i.test(message);
}

async function callFactoryRpc<T>(functionName: string, args: Record<string, unknown>): Promise<T> {
	const { data, error } = await supabase.rpc(functionName, args);
	if (error) throw error;
	return data as T;
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asRecord = (value: unknown): FactoryRecord =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as FactoryRecord) : {};
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asCount = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function normalizeOverview(raw: unknown): FactoryOverview {
	const record = asRecord(raw);
	return {
		as_of: asString(record.as_of),
		since: asString(record.since),
		counts: asRecord(record.counts) as unknown as FactoryOverview["counts"],
		workers: asArray(record.workers),
		coverage: asArray<unknown>(record.coverage).filter((item): item is string => typeof item === "string"),
	};
}

function normalizePage(raw: unknown): FactoryDatasetsPage {
	const record = asRecord(raw);
	return {
		as_of: asString(record.as_of),
		total: asCount(record.total),
		items: asArray<FactoryRow>(record.items),
	};
}

function normalizeDetail(raw: unknown): FactoryDatasetDetail | null {
	const record = asRecord(raw);
	const dataset = record.dataset;
	if (!dataset || typeof dataset !== "object") return null;
	const outputs = asRecord(record.outputs);
	return {
		as_of: asString(record.as_of),
		dataset: dataset as FactoryRow,
		status: asRecord(record.status),
		queue: asArray(record.queue),
		record_totals: asRecord(record.record_totals) as Record<string, number>,
		logs: asArray(record.logs),
		log_total: typeof record.log_total === "number" ? record.log_total : null,
		outputs: {
			orthos: asArray(outputs.orthos),
			cogs: asArray(outputs.cogs),
			thumbnails: asArray(outputs.thumbnails),
			raw_images: asArray(outputs.raw_images),
		},
		notifications: asArray(record.notifications),
		publications: asArray(record.publications),
		reports: asArray(record.reports),
		audits: asArray(record.audits),
		corrections: asArray(record.corrections),
		correction_total: typeof record.correction_total === "number" ? record.correction_total : null,
	};
}

function normalizeTrends(
	raw: unknown,
	requested: { interval: FactoryTrendInterval; workflow: FactoryTrendWorkflow; size: FactoryTrendSize }
): FactoryTrends {
	const record = asRecord(raw);
	const summary = record.summary && typeof record.summary === "object" ? (asRecord(record.summary) as unknown as FactoryTrends["summary"]) : null;
	return {
		as_of: asString(record.as_of),
		tracking_since: asString(record.tracking_since),
		interval: record.interval === "day" ? "day" : record.interval === "week" ? "week" : requested.interval,
		workflow: (asString(record.workflow) as FactoryTrendWorkflow | null) ?? requested.workflow,
		size: (asString(record.size) as FactoryTrendSize | null) ?? requested.size,
		summary,
		series: asArray(record.series),
		coverage: asArray<unknown>(record.coverage).filter((item): item is string => typeof item === "string"),
	};
}

function normalizeJourney(raw: unknown): FactoryJourney {
	const record = asRecord(raw);
	return {
		as_of: asString(record.as_of),
		tracking_since: asString(record.tracking_since),
		activation_tracking_since: asString(record.activation_tracking_since),
		pipeline: record.pipeline && typeof record.pipeline === "object" ? (asRecord(record.pipeline) as unknown as FactoryJourney["pipeline"]) : null,
		weekly: asArray(record.weekly),
		cohorts: asArray(record.cohorts),
		coverage: asArray<unknown>(record.coverage).filter((item): item is string => typeof item === "string"),
	};
}

function normalizeOperations(raw: unknown): FactoryOperations {
	const record = asRecord(raw);
	return {
		as_of: asString(record.as_of),
		attention_total: asCount(record.attention_total),
		attention_contributors: asCount(record.attention_contributors),
		attention: asArray(record.attention),
		waiting: asArray(record.waiting),
		coverage: asArray<unknown>(record.coverage).filter((item): item is string => typeof item === "string"),
	};
}

function normalizeActivity(raw: unknown): FactoryActivityPage {
	const record = asRecord(raw);
	return {
		as_of: asString(record.as_of),
		total: asCount(record.total),
		items: asArray(record.items),
	};
}

export async function fetchFactoryDatasets(
	filters: FactoryFilters,
	limit: number,
	offset: number
): Promise<FactoryDatasetsPage> {
	const raw = await callFactoryRpc<unknown>("factory_datasets", {
		p_filters: toRpcFilters(filters),
		p_limit: limit,
		p_offset: offset,
	});
	return normalizePage(raw);
}

/** Fresh rows for a handoff snapshot. Chunked so large selections stay within the RPC limit. */
export interface FactorySnapshotRows {
	/** Time of the last read. */
	as_of: string | null;
	/** Time of the first read; equals `as_of` when one read was enough. */
	as_of_first: string | null;
	reads: number;
	rows: FactoryRow[];
}

export async function fetchFactoryRowsByIds(ids: number[]): Promise<FactorySnapshotRows> {
	if (ids.length === 0) return { as_of: null, as_of_first: null, reads: 0, rows: [] };
	const rows: FactoryRow[] = [];
	let asOf: string | null = null;
	let asOfFirst: string | null = null;
	let reads = 0;
	for (let start = 0; start < ids.length; start += FACTORY_MAX_RPC_LIMIT) {
		const chunk = ids.slice(start, start + FACTORY_MAX_RPC_LIMIT);
		const page = await fetchFactoryDatasets({ ids: chunk, archived: "all" }, chunk.length, 0);
		rows.push(...page.items);
		reads += 1;
		asOf = page.as_of ?? asOf;
		asOfFirst = asOfFirst ?? page.as_of;
	}
	const order = new Map(ids.map((id, index) => [id, index]));
	rows.sort((a, b) => (order.get(a.dataset_id) ?? 0) - (order.get(b.dataset_id) ?? 0));
	return { as_of: asOf, as_of_first: asOfFirst, reads, rows };
}

function useFactoryAccess() {
	const { user } = useAuth();
	const { canOperate, isLoading } = useCanOperate();
	return { enabled: !!user?.id && canOperate, isPrivilegeLoading: isLoading };
}

const factoryRetry = (failureCount: number, error: unknown) => !isFactoryPermissionError(error) && failureCount < 1;

export function useFactoryOverview(days: number) {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "overview", days],
		enabled,
		queryFn: async () => normalizeOverview(await callFactoryRpc<unknown>("factory_overview", { p_days: days })),
		retry: factoryRetry,
		staleTime: 30 * 1000,
	});
}

export function useFactoryDatasets(filters: FactoryFilters, page: number, pageSize: number) {
	const { enabled } = useFactoryAccess();
	const rpcFilters = toRpcFilters(filters);
	return useQuery({
		queryKey: ["factory", "datasets", rpcFilters, page, pageSize],
		enabled,
		queryFn: () => fetchFactoryDatasets(filters, pageSize, (page - 1) * pageSize),
		retry: factoryRetry,
		staleTime: 30 * 1000,
		placeholderData: keepPreviousData,
	});
}

export function useFactoryDataset(datasetId: number | null) {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "dataset", datasetId],
		enabled: enabled && datasetId !== null && Number.isInteger(datasetId) && datasetId > 0,
		queryFn: async () =>
			normalizeDetail(await callFactoryRpc<unknown>("factory_dataset", { p_dataset_id: datasetId })),
		retry: factoryRetry,
		staleTime: 15 * 1000,
	});
}

export function useFactoryActivity(kind: FactoryActivityKind, page: number, pageSize: number) {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "activity", kind, page, pageSize],
		enabled,
		queryFn: async () =>
			normalizeActivity(
				await callFactoryRpc<unknown>("factory_activity", {
					p_kind: kind,
					p_limit: pageSize,
					p_offset: (page - 1) * pageSize,
				})
			),
		retry: factoryRetry,
		staleTime: 30 * 1000,
		placeholderData: keepPreviousData,
	});
}

export function useFactoryTrends(interval: FactoryTrendInterval, workflow: FactoryTrendWorkflow, size: FactoryTrendSize) {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "trends", interval, workflow, size],
		enabled,
		queryFn: async () =>
			normalizeTrends(
				await callFactoryRpc<unknown>("factory_trends", { p_interval: interval, p_workflow: workflow, p_size: size }),
				{ interval, workflow, size }
			),
		retry: factoryRetry,
		staleTime: 60 * 1000,
	});
}

export function useFactoryJourney(active = true) {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "journey"],
		enabled: enabled && active,
		queryFn: async () => normalizeJourney(await callFactoryRpc<unknown>("factory_journey", {})),
		retry: factoryRetry,
		staleTime: 60 * 1000,
	});
}

export function useFactoryOperations() {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "operations"],
		enabled,
		queryFn: async () => normalizeOperations(await callFactoryRpc<unknown>("factory_operations", {})),
		retry: factoryRetry,
		staleTime: 30 * 1000,
	});
}

function normalizeHistory(raw: unknown): FactoryHistory {
	const record = asRecord(raw);
	const coverage = asRecord(record.coverage);
	const counts = ["datasets", "upload_evidence", "upload_sizes", "timing_pairs", "measured_uploads", "ready_now"];
	// A broken response must be a query error, never fabricated zeros or a render crash.
	if (!Array.isArray(record.series) || !Array.isArray(record.years) || counts.some((key) => asCount(coverage[key]) === null)) {
		throw new Error("Historical activity returned an incomplete response.");
	}
	return { ...record, series: asArray(record.series), coverage } as unknown as FactoryHistory;
}

export function useFactoryHistory(year: number | null) {
	const { enabled } = useFactoryAccess();
	return useQuery({
		queryKey: ["factory", "history", year],
		enabled,
		queryFn: async () => normalizeHistory(await callFactoryRpc<unknown>("factory_history", { p_year: year })),
		retry: factoryRetry,
		staleTime: 60 * 1000,
	});
}
