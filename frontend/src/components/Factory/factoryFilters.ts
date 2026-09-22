import {
	FACTORY_METRIC_FILTERS,
	FACTORY_NOTIFICATION_FILTERS,
	FACTORY_PUBLICATION_FILTERS,
	FACTORY_SORTS,
	FACTORY_STATES,
	type FactoryArchivedFilter,
	type FactoryFilters,
	FACTORY_TREND_SIZES,
	FACTORY_TREND_WORKFLOWS,
	type FactoryMetricFilter,
	type FactoryNotificationFilter,
	type FactoryPublicationFilter,
	type FactorySort,
	type FactoryTrendSize,
	type FactoryTrendWorkflow,
	type FactoryState,
} from "./factoryTypes";

export const FACTORY_PAGE_SIZE = 50;
export const FACTORY_MAX_RPC_LIMIT = 500;

const isOneOf = <T extends string>(values: readonly T[], candidate: string | null): candidate is T =>
	candidate !== null && (values as readonly string[]).includes(candidate);

const parseBoolean = (value: string | null): boolean | undefined => {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
};

const parseIsoDate = (value: string | null): string | undefined => {
	if (!value) return undefined;
	return Number.isNaN(new Date(value).getTime()) ? undefined : value;
};

/** Accepts "671, 10494 10545" style input and returns unique positive integers. */
export function parseIdList(text: string | null | undefined): number[] {
	if (!text) return [];
	const ids = text
		.split(/[\s,;]+/)
		.map((part) => part.replace(/^#/, ""))
		.filter(Boolean)
		.map((part) => Number(part))
		.filter((value) => Number.isInteger(value) && value > 0);
	return Array.from(new Set(ids));
}

export function parseFactoryFilters(params: URLSearchParams): FactoryFilters {
	const filters: FactoryFilters = {};
	const search = params.get("search")?.trim();
	if (search) filters.search = search;

	const state = params.get("state");
	if (isOneOf<FactoryState>(FACTORY_STATES, state)) filters.state = state;

	const worker = params.get("worker")?.trim();
	if (worker) filters.worker = worker;

	const notification = params.get("notification");
	if (isOneOf<FactoryNotificationFilter>(FACTORY_NOTIFICATION_FILTERS, notification)) {
		filters.notification = notification;
	}

	const publication = params.get("publication");
	if (isOneOf<FactoryPublicationFilter>(FACTORY_PUBLICATION_FILTERS, publication)) {
		filters.publication = publication;
	}

	if (params.get("reports") === "open") filters.reports = "open";

	const contributor = params.get("contributor")?.trim();
	if (contributor && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contributor)) filters.contributor = contributor;

	const createdAfter = parseIsoDate(params.get("created_after"));
	if (createdAfter) filters.created_after = createdAfter;
	const createdBefore = parseIsoDate(params.get("created_before"));
	if (createdBefore) filters.created_before = createdBefore;

	const ids = parseIdList(params.get("ids"));
	if (ids.length) filters.ids = ids;

	const archived = params.get("archived");
	if (archived === "all" || archived === "yes") filters.archived = archived as FactoryArchivedFilter;

	const attention = parseBoolean(params.get("attention"));
	if (attention) filters.attention = true;

	const uploaded = parseBoolean(params.get("uploaded"));
	if (uploaded !== undefined) filters.uploaded = uploaded;
	const hasAudit = parseBoolean(params.get("has_audit"));
	if (hasAudit !== undefined) filters.has_audit = hasAudit;
	const ready = parseBoolean(params.get("ready"));
	if (ready !== undefined) filters.ready = ready;
	const hasError = parseBoolean(params.get("has_error"));
	if (hasError !== undefined) filters.has_error = hasError;

	const metric = params.get("metric");
	if (isOneOf<FactoryMetricFilter>(FACTORY_METRIC_FILTERS, metric)) filters.metric = metric;
	const metricAfter = parseIsoDate(params.get("metric_after"));
	if (metricAfter) filters.metric_after = metricAfter;
	const metricBefore = parseIsoDate(params.get("metric_before"));
	if (metricBefore) filters.metric_before = metricBefore;
	const workflow = params.get("workflow");
	if (isOneOf<FactoryTrendWorkflow>(FACTORY_TREND_WORKFLOWS, workflow) && workflow !== "all") filters.workflow = workflow;
	const size = params.get("size");
	if (isOneOf<FactoryTrendSize>(FACTORY_TREND_SIZES, size) && size !== "all") filters.size = size;
	const sort = params.get("sort");
	if (isOneOf<FactorySort>(FACTORY_SORTS, sort)) filters.sort = sort;

	return filters;
}

export function serializeFactoryFilters(filters: FactoryFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.search) params.set("search", filters.search);
	if (filters.state) params.set("state", filters.state);
	if (filters.worker) params.set("worker", filters.worker);
	if (filters.notification) params.set("notification", filters.notification);
	if (filters.publication) params.set("publication", filters.publication);
	if (filters.reports) params.set("reports", filters.reports);
	if (filters.contributor) params.set("contributor", filters.contributor);
	if (filters.created_after) params.set("created_after", filters.created_after);
	if (filters.created_before) params.set("created_before", filters.created_before);
	if (filters.ids?.length) params.set("ids", filters.ids.join(","));
	if (filters.archived && filters.archived !== "no") params.set("archived", filters.archived);
	if (filters.attention) params.set("attention", "true");
	if (filters.uploaded !== undefined) params.set("uploaded", String(filters.uploaded));
	if (filters.has_audit !== undefined) params.set("has_audit", String(filters.has_audit));
	if (filters.ready !== undefined) params.set("ready", String(filters.ready));
	if (filters.has_error !== undefined) params.set("has_error", String(filters.has_error));
	if (filters.metric) params.set("metric", filters.metric);
	if (filters.metric_after) params.set("metric_after", filters.metric_after);
	if (filters.metric_before) params.set("metric_before", filters.metric_before);
	if (filters.workflow && filters.workflow !== "all") params.set("workflow", filters.workflow);
	if (filters.size && filters.size !== "all") params.set("size", filters.size);
	if (filters.sort) params.set("sort", filters.sort);
	return params;
}

/** The JSON object handed to `factory_datasets(p_filters)`. Only set keys are sent. */
export function toRpcFilters(filters: FactoryFilters): Record<string, unknown> {
	const rpc: Record<string, unknown> = {};
	(Object.keys(filters) as (keyof FactoryFilters)[]).forEach((key) => {
		const value = filters[key];
		if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
		if (key === "archived" && value === "no") return;
		if ((key === "workflow" || key === "size") && value === "all") return;
		rpc[key] = value;
	});
	return rpc;
}

export function parsePage(params: URLSearchParams): number {
	const page = Number(params.get("page"));
	return Number.isInteger(page) && page > 0 ? page : 1;
}

export function countActiveFilters(filters: FactoryFilters): number {
	return Object.keys(toRpcFilters(filters)).filter((key) => key !== "sort").length;
}

/** Validates a filter object handed over by the server (for example a waiting group) into typed filters. */
export function filtersFromRecord(record: Record<string, unknown> | null | undefined): FactoryFilters {
	const params = new URLSearchParams();
	Object.entries(record ?? {}).forEach(([key, value]) => {
		if (value === null || value === undefined) return;
		params.set(key, Array.isArray(value) ? value.join(",") : String(value));
	});
	return parseFactoryFilters(params);
}

export function factoryDatasetsPath(filters: FactoryFilters, page?: number): string {
	const params = serializeFactoryFilters(filters);
	if (page && page > 1) params.set("page", String(page));
	const query = params.toString();
	return query ? `/factory/datasets?${query}` : "/factory/datasets";
}
