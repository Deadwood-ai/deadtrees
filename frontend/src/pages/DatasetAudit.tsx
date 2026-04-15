import { useEffect, useState, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Dayjs } from "dayjs";
import {
	Table,
	Button,
	Result,
	Spin,
	Typography,
	message,
	Tag,
	Tooltip,
	Segmented,
	Input,
	Space,
	Checkbox,
	Select,
	Collapse,
	Badge,
	DatePicker,
	Drawer,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import {
	SearchOutlined,
	FilterOutlined,
	FlagOutlined,
	EditOutlined,
} from "@ant-design/icons";
import { useAuth } from "../hooks/useAuthProvider";
import { useCanAudit } from "../hooks/useUserPrivileges";
import { useDatasets } from "../hooks/useDatasets";
import DatasetAuditDetail from "../components/DatasetAudit/DatasetAuditDetail";
import { IDataset } from "../types/dataset";
import { useDatasetAudits, DatasetAuditUserInfo, useDatasetContributors } from "../hooks/useDatasetAudit";
import { supabase } from "../hooks/useSupabase";
import { useFlaggedDatasets } from "../hooks/useDatasetFlags";
import { useReferenceDatasetIds } from "../hooks/useReferencePatches";
import { useAuditNavigation } from "../hooks/useAuditNavigation";
import { usePendingCorrections } from "../hooks/usePendingCorrections";
import { palette } from "../theme/palette";
import { getBiomeEmoji, getBiomeTagColor, truncateBiomeLabel } from "../utils/biomeDisplay";
import { useDatasetLogs, useProcessingOverview, ProcessingOverviewRow, ProcessingStatus } from "../hooks/useProcessingOverview";
import { getAcquisitionPeriod } from "../utils/phenologyUtils";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAnalytics } from "../hooks/useAnalytics";

const { Title, Text } = Typography;

// Tab structure including edits & flags
type AuditTab = "pending" | "completed" | "reference" | "edits-flags" | "processing";

// Status sub-filter for completed tab
type CompletedStatusFilter = "all" | "ready" | "fixable" | "excluded" | "needs-review" | "reviewed";

type ProcessingStateFilterKey = "ortho" | "cog" | "thumbnail" | "deadwood" | "forestCover" | "metadata";
type AcquisitionMonthRange = [Dayjs | null, Dayjs | null] | null;

const PROCESSING_STATE_OPTIONS: Array<{ label: string; value: ProcessingStateFilterKey }> = [
	{ label: "Ortho", value: "ortho" },
	{ label: "COG", value: "cog" },
	{ label: "Thumb", value: "thumbnail" },
	{ label: "Deadwood", value: "deadwood" },
	{ label: "Forest", value: "forestCover" },
	{ label: "Metadata", value: "metadata" },
];

const PROCESSING_STATE_TO_FIELD: Record<ProcessingStateFilterKey, keyof IDataset> = {
	ortho: "is_ortho_done",
	cog: "is_cog_done",
	thumbnail: "is_thumbnail_done",
	deadwood: "is_deadwood_done",
	forestCover: "is_forest_cover_done",
	metadata: "is_metadata_done",
};
const DEFAULT_PROCESSING_STATE_FILTERS: ProcessingStateFilterKey[] = PROCESSING_STATE_OPTIONS.map((option) => option.value);

const BADGE_OVERFLOW_COUNT = 999999;
const DEFAULT_PROCESSING_STATUS_FILTERS: ProcessingStatus[] = ["QUEUED", "PROCESSING", "FAILED"];

const formatHours = (value: number | null | undefined): string => {
	if (typeof value !== "number" || Number.isNaN(value)) return "—";
	return `${value.toFixed(1)}h`;
};

// Helper function to check if dataset processing is complete
const isProcessingComplete = (dataset: IDataset) => {
	return (
		dataset.is_upload_done &&
		dataset.is_ortho_done &&
		dataset.is_cog_done &&
		dataset.is_thumbnail_done &&
		dataset.is_deadwood_done &&
		dataset.is_metadata_done
	);
};

// Helper to format location
const formatLocation = (dataset: IDataset): string => {
	const parts = [dataset.admin_level_3, dataset.admin_level_1].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "Unknown";
};

// Helper to format acquisition date
const formatAcquisitionDate = (dataset: IDataset): string => {
	const { aquisition_year, aquisition_month, aquisition_day } = dataset;
	if (!aquisition_year) return "Unknown";
	const parts = [String(aquisition_year)];
	if (aquisition_month) parts.push(String(aquisition_month).padStart(2, "0"));
	if (aquisition_day) parts.push(String(aquisition_day).padStart(2, "0"));
	return parts.join("-");
};

const compareNullableStrings = (a: string | null | undefined, b: string | null | undefined): number => {
	return (a || "").localeCompare(b || "", undefined, { sensitivity: "base" });
};

const compareNullableNumbers = (a: number | null | undefined, b: number | null | undefined): number => {
	const aNum = typeof a === "number" ? a : null;
	const bNum = typeof b === "number" ? b : null;
	if (aNum === null && bNum === null) return 0;
	if (aNum === null) return 1; // nulls last
	if (bNum === null) return -1;
	return aNum - bNum;
};

const getPhenologyProbability = (dataset: IDataset, curve: number[] | null | undefined): number | null => {
	if (!curve || curve.length === 0) return null;

	const year = parseInt(dataset.aquisition_year, 10);
	if (isNaN(year)) return null;

	const parsedMonth = parseInt(dataset.aquisition_month, 10);
	const parsedDay = parseInt(dataset.aquisition_day, 10);
	const month = !isNaN(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : undefined;
	const day = !isNaN(parsedDay) && parsedDay >= 1 && parsedDay <= 31 ? parsedDay : undefined;

	const period = getAcquisitionPeriod(year, month, day);
	const index = Math.max(0, Math.min(curve.length - 1, period.centerDay - 1));
	const value = curve[index];
	if (typeof value !== "number" || Number.isNaN(value)) return null;

	return Math.max(0, Math.min(1, value / 255));
};

const getAcquisitionMonthIndex = (dataset: IDataset): number | null => {
	const year = parseInt(dataset.aquisition_year, 10);
	const month = parseInt(dataset.aquisition_month, 10);
	if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null;
	return year * 12 + (month - 1);
};

const getAcquisitionDateSortKey = (dataset: IDataset): number | null => {
	const year = parseInt(dataset.aquisition_year, 10);
	const month = parseInt(dataset.aquisition_month, 10);
	const day = parseInt(dataset.aquisition_day, 10);
	if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null;
	// Sort with month-level precision; day is optional and only used as a tie-breaker.
	const safeDay = !isNaN(day) && day >= 1 && day <= 31 ? day : 0;
	return year * 10000 + month * 100 + safeDay;
};

const getBiomeBadge = (biomeName: string | null) => {
	if (!biomeName) return <Tag color="default">Unknown</Tag>;

	return (
		<Tooltip title={biomeName}>
			<Tag color={getBiomeTagColor(biomeName)}>
				{getBiomeEmoji(biomeName)} {truncateBiomeLabel(biomeName)}
			</Tag>
		</Tooltip>
	);
};

export default function DatasetAudit() {
	const navigate = useNavigate();
	const { user } = useAuth();
	const { canAudit, isLoading: isAuditPrivilegeLoading } = useCanAudit();

	if (isAuditPrivilegeLoading) {
		return (
			<div className="flex h-full w-full items-center justify-center" style={{ minHeight: "60vh" }}>
				<Spin size="large" />
			</div>
		);
	}

	if (!user || !canAudit) {
		return (
			<Result
				status="403"
				title="Forbidden"
				subTitle="Auditor access is required to view this page."
				extra={[
					<Button key="home" onClick={() => navigate("/")} type="primary">
						Home
					</Button>,
					<Button key="datasets" onClick={() => navigate("/dataset")}>
						Datasets
					</Button>,
				]}
			/>
		);
	}

	return <DatasetAuditInner />;
}

function DatasetAuditInner() {
	const isMobile = useIsMobile();
	const { id } = useParams();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const { setFilteredDatasetIds } = useAuditNavigation();
	const { track } = useAnalytics("audit");

	// ALL HOOKS MUST BE CALLED FIRST
	const { user } = useAuth();
	const isAuthLoading = false;
	const { canAudit, isLoading: isAuditPrivilegeLoading } = useCanAudit();
	const { data: datasets, isLoading: isDatasetLoading } = useDatasets();
	const { data: audits, isLoading: isAuditsLoading } = useDatasetAudits();
	const { data: flaggedAgg = [], isLoading: isFlaggedLoading } = useFlaggedDatasets();
	const { data: referenceDatasetIds = new Set() } = useReferenceDatasetIds();
	const { data: contributorMap = new Map() } = useDatasetContributors();
	const { data: correctionsMap = new Map(), isLoading: isCorrectionsLoading } = usePendingCorrections();
	const {
		data: processingRows = [],
		isLoading: isProcessingLoading,
		refetch: refetchProcessingRows,
	} = useProcessingOverview();

	// Filter states - initialize from URL params
	const initialTab = (searchParams.get("tab") as AuditTab) || "pending";
	const initialStatus = (searchParams.get("status") as CompletedStatusFilter) || "all";
	const initialBiome = searchParams.get("biome") || "";
	const initialCountry = searchParams.get("country") || "";
	const initialAuditor = searchParams.get("auditor") || "";
	const initialContributor = searchParams.get("contributor") || "";
	const initialHasFlags = searchParams.get("hasFlags") === "true";

	const [activeTab, setActiveTab] = useState<AuditTab>(initialTab);
	const [statusFilter, setStatusFilter] = useState<CompletedStatusFilter>(initialStatus);
	const [idFilter, setIdFilter] = useState<string>(searchParams.get("id") || "");
	const [acquisitionMonthRange, setAcquisitionMonthRange] = useState<AcquisitionMonthRange>(null);
	const [biomeFilter, setBiomeFilter] = useState<string>(initialBiome);
	const [countryFilter, setCountryFilter] = useState<string>(initialCountry);
	const [auditorFilter, setAuditorFilter] = useState<string>(initialAuditor);
	const [contributorFilter, setContributorFilter] = useState<string>(initialContributor);
	const [hasFlagsFilter, setHasFlagsFilter] = useState<boolean>(initialHasFlags);
	const [hasProcessingStates, setHasProcessingStates] = useState<ProcessingStateFilterKey[]>(DEFAULT_PROCESSING_STATE_FILTERS);
	const [inSeasonOnly, setInSeasonOnly] = useState<boolean>(false);
	const [filtersExpanded, setFiltersExpanded] = useState<boolean>(true);
	const [processingStatusFilters, setProcessingStatusFilters] = useState<ProcessingStatus[]>(
		DEFAULT_PROCESSING_STATUS_FILTERS
	);
	const [processingStageFilter, setProcessingStageFilter] = useState<string | undefined>(undefined);
	const [processingUserFilter, setProcessingUserFilter] = useState<string | undefined>(undefined);
	const [selectedProcessingDatasetId, setSelectedProcessingDatasetId] = useState<number | null>(null);
	const [logLimit, setLogLimit] = useState<number>(100);

	// Update URL when filters change
	useEffect(() => {
		const params = new URLSearchParams();
		params.set("tab", activeTab);
		if (statusFilter !== "all") params.set("status", statusFilter);
		if (biomeFilter) params.set("biome", biomeFilter);
		if (countryFilter) params.set("country", countryFilter);
		if (auditorFilter) params.set("auditor", auditorFilter);
		if (contributorFilter) params.set("contributor", contributorFilter);
		if (hasFlagsFilter) params.set("hasFlags", "true");
		if (idFilter) params.set("id", idFilter);
		setSearchParams(params, { replace: true });
	}, [activeTab, statusFilter, biomeFilter, countryFilter, auditorFilter, contributorFilter, hasFlagsFilter, idFilter, setSearchParams]);

	// Minimum dataset ID for auditing
	const MIN_AUDIT_DATASET_ID = 2559;
	const hasAboveMinId = useMemo(() => {
		return (datasets || []).some((d) => d.id > MIN_AUDIT_DATASET_ID);
	}, [datasets]);

	// Create maps for quick lookup
	const auditMap = useMemo(() => {
		if (!audits) return new Map<number, DatasetAuditUserInfo>();
		return new Map(audits.map((audit) => [audit.dataset_id, audit as unknown as DatasetAuditUserInfo]));
	}, [audits]);

	const flaggedMap = useMemo(() => new Map(flaggedAgg.map((r) => [r.dataset_id, r])), [flaggedAgg]);

	// Extract unique values for filters
	const uniqueBiomes = useMemo(() => {
		if (!datasets) return [];
		const biomes = new Set(datasets.map((d) => d.biome_name).filter(Boolean));
		return Array.from(biomes).sort();
	}, [datasets]);

	const uniqueCountries = useMemo(() => {
		if (!datasets) return [];
		const countries = new Set(datasets.map((d) => d.admin_level_1).filter(Boolean));
		return Array.from(countries).sort();
	}, [datasets]);

	const uniqueAuditors = useMemo(() => {
		if (!audits) return [];
		const auditors = new Set(
			audits
				.map((a) => (a as unknown as DatasetAuditUserInfo).audited_by_email)
				.filter(Boolean)
		);
		return Array.from(auditors).sort();
	}, [audits]);

	const uniqueContributors = useMemo(() => {
		if (!contributorMap || contributorMap.size === 0) return [];
		const contributors = new Set(Array.from(contributorMap.values()).filter(Boolean));
		return Array.from(contributors).sort() as string[];
	}, [contributorMap]);

	const processingStageOptions = useMemo(() => {
		const stages = new Set(
			processingRows
				.map((row) => row.current_status)
				.filter((status): status is string => typeof status === "string" && status.length > 0)
		);
		return Array.from(stages)
			.sort()
			.map((value) => ({ label: value, value }));
	}, [processingRows]);

	const processingUserOptions = useMemo(() => {
		const users = new Set(
			processingRows
				.map((row) => row.user_email)
				.filter((email): email is string => typeof email === "string" && email.length > 0)
		);
		return Array.from(users)
			.sort()
			.map((value) => ({ label: value, value }));
	}, [processingRows]);

	const filteredProcessingRows = useMemo(() => {
		return processingRows.filter((row) => {
			if (processingStatusFilters.length > 0) {
				const rowStatus = row.processing_status || "";
				if (!processingStatusFilters.includes(rowStatus as ProcessingStatus)) return false;
			}
			if (processingStageFilter && row.current_status !== processingStageFilter) return false;
			if (processingUserFilter && row.user_email !== processingUserFilter) return false;
			return true;
		});
	}, [processingRows, processingStatusFilters, processingStageFilter, processingUserFilter]);

	const processingCount = useMemo(() => {
		return processingRows.filter((row) =>
			DEFAULT_PROCESSING_STATUS_FILTERS.includes((row.processing_status || "") as ProcessingStatus)
		).length;
	}, [processingRows]);

	const selectedProcessingRow = useMemo(
		() => processingRows.find((row) => row.dataset_id === selectedProcessingDatasetId) || null,
		[processingRows, selectedProcessingDatasetId]
	);

	const { data: selectedDatasetLogs = [], isLoading: isLogsLoading, refetch: refetchSelectedDatasetLogs } = useDatasetLogs(
		selectedProcessingDatasetId,
		logLimit
	);

	// Filter datasets based on tab and filters
	const filteredDatasets = useMemo(() => {
		if (!datasets) return [];

		let filtered = datasets;

		// Apply minimum ID filter only for core audit workflow tabs.
		// Edits & Flags and Reference should include legacy dataset IDs.
		if ((activeTab === "pending" || activeTab === "completed") && hasAboveMinId) {
			filtered = filtered.filter((dataset) => dataset.id > MIN_AUDIT_DATASET_ID);
		}

		// Tab-based filtering
		if (activeTab === "pending") {
			filtered = filtered.filter((dataset) => !dataset.is_audited && isProcessingComplete(dataset));
		} else if (activeTab === "completed") {
			filtered = filtered.filter((dataset) => dataset.is_audited);

			// Apply status sub-filter
			if (statusFilter !== "all") {
				filtered = filtered.filter((dataset) => {
					const audit = auditMap.get(dataset.id);
					if (!audit) return false;

					switch (statusFilter) {
						case "ready":
							return audit.final_assessment === "no_issues";
						case "fixable":
							return audit.final_assessment === "fixable_issues";
						case "excluded":
							return audit.final_assessment === "exclude_completely";
						case "needs-review":
							return !audit.reviewed_at;
						case "reviewed":
							return !!audit.reviewed_at;
						default:
							return true;
					}
				});
			}
		} else if (activeTab === "reference") {
			filtered = filtered.filter((dataset) => referenceDatasetIds.has(dataset.id));
		} else if (activeTab === "edits-flags") {
			// Filter for datasets with pending corrections OR user flags
			const flaggedSet = new Set(flaggedAgg.map((f) => f.dataset_id));
			filtered = filtered.filter((dataset) =>
				correctionsMap.has(dataset.id) || flaggedSet.has(dataset.id)
			);
		}

		// Apply common filters
		if (idFilter.trim()) {
			const idNumber = parseInt(idFilter.trim());
			if (!isNaN(idNumber)) {
				filtered = filtered.filter((dataset) => dataset.id === idNumber);
			} else {
				filtered = [];
			}
		}

		const acquisitionStart = acquisitionMonthRange?.[0] ?? null;
		const acquisitionEnd = acquisitionMonthRange?.[1] ?? null;
		const acquisitionStartIndex =
			acquisitionStart && typeof acquisitionStart.year === "function" && typeof acquisitionStart.month === "function"
				? acquisitionStart.year() * 12 + acquisitionStart.month()
				: null;
		const acquisitionEndIndex =
			acquisitionEnd && typeof acquisitionEnd.year === "function" && typeof acquisitionEnd.month === "function"
				? acquisitionEnd.year() * 12 + acquisitionEnd.month()
				: null;

		if (acquisitionStartIndex !== null || acquisitionEndIndex !== null) {
			filtered = filtered.filter((dataset) => {
				const idx = getAcquisitionMonthIndex(dataset);
				if (idx === null) return false;
				if (acquisitionStartIndex !== null && idx < acquisitionStartIndex) return false;
				if (acquisitionEndIndex !== null && idx > acquisitionEndIndex) return false;
				return true;
			});
		}

		if (biomeFilter) {
			filtered = filtered.filter((dataset) => dataset.biome_name === biomeFilter);
		}

		if (countryFilter) {
			filtered = filtered.filter((dataset) => dataset.admin_level_1 === countryFilter);
		}

		if (auditorFilter && activeTab === "completed") {
			filtered = filtered.filter((dataset) => {
				const audit = auditMap.get(dataset.id);
				return audit?.audited_by_email === auditorFilter;
			});
		}

		if (contributorFilter) {
			filtered = filtered.filter((dataset) => {
				const email = contributorMap.get(dataset.id) || auditMap.get(dataset.id)?.uploaded_by_email;
				return email === contributorFilter;
			});
		}

		if (hasFlagsFilter) {
			const flaggedSet = new Set(flaggedAgg.map((f) => f.dataset_id));
			filtered = filtered.filter((d) => flaggedSet.has(d.id));
		}

		// Completed-only processing state filters (helps find "fixable but missing forest cover", etc.)
		if (activeTab === "completed" && hasProcessingStates.length > 0) {
			filtered = filtered.filter((dataset) =>
				hasProcessingStates.every((key) => Boolean(dataset[PROCESSING_STATE_TO_FIELD[key]]))
			);
		}

		if (activeTab === "completed" && inSeasonOnly) {
			filtered = filtered.filter((dataset) => auditMap.get(dataset.id)?.has_valid_phenology === true);
		}

		return filtered;
	}, [
		datasets,
		activeTab,
		statusFilter,
		idFilter,
		acquisitionMonthRange,
		biomeFilter,
		countryFilter,
		auditorFilter,
		contributorFilter,
		hasFlagsFilter,
		hasProcessingStates,
		inSeasonOnly,
		auditMap,
		contributorMap,
		flaggedAgg,
		hasAboveMinId,
		referenceDatasetIds,
	]);

	const pendingDatasetIds = useMemo(() => {
		if (activeTab !== "pending") return [];
		return filteredDatasets.map((dataset) => dataset.id);
	}, [activeTab, filteredDatasets]);

	const { data: pendingPhenologyProbabilityMap = new Map<number, number | null>(), isLoading: isPendingPhenologyLoading } = useQuery({
		queryKey: ["audit-pending-phenology-probabilities", pendingDatasetIds],
		enabled: activeTab === "pending" && pendingDatasetIds.length > 0,
		queryFn: async () => {
			const datasetById = new Map(filteredDatasets.map((dataset) => [dataset.id, dataset]));
			const probabilities = new Map<number, number | null>();
			pendingDatasetIds.forEach((id) => probabilities.set(id, null));

			const chunkSize = 500;
			for (let i = 0; i < pendingDatasetIds.length; i += chunkSize) {
				const chunk = pendingDatasetIds.slice(i, i + chunkSize);
				const { data, error } = await supabase
					.from("v2_metadata")
					.select("dataset_id, metadata")
					.in("dataset_id", chunk);

				if (error) throw error;

				for (const row of data || []) {
					const datasetId = (row as { dataset_id?: number }).dataset_id;
					if (typeof datasetId !== "number") continue;

					const curve = (row as { metadata?: { phenology?: { phenology_curve?: number[] } } }).metadata?.phenology?.phenology_curve;
					const dataset = datasetById.get(datasetId);
					if (!dataset) continue;

					probabilities.set(datasetId, getPhenologyProbability(dataset, curve));
				}
			}

			return probabilities;
		},
		staleTime: 5 * 60 * 1000,
	});

	const sortedFilteredDatasets = useMemo(() => {
		if (activeTab !== "pending") return filteredDatasets;

		return [...filteredDatasets].sort((a, b) => {
			const aProb = pendingPhenologyProbabilityMap.get(a.id);
			const bProb = pendingPhenologyProbabilityMap.get(b.id);
			const aValue = typeof aProb === "number" ? aProb : -1;
			const bValue = typeof bProb === "number" ? bProb : -1;
			if (bValue !== aValue) return bValue - aValue;
			return b.id - a.id;
		});
	}, [activeTab, filteredDatasets, pendingPhenologyProbabilityMap]);

	// Update navigation context with filtered dataset IDs (sorted by ID descending to match table order)
	const filteredIds = useMemo(() => {
		if (activeTab === "pending") {
			return sortedFilteredDatasets.map((dataset) => dataset.id);
		}
		return [...filteredDatasets].sort((a, b) => b.id - a.id).map((dataset) => dataset.id);
	}, [activeTab, sortedFilteredDatasets, filteredDatasets]);

	useEffect(() => {
		setFilteredDatasetIds(filteredIds);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filteredIds.join(",")]);

	// Compute counts for tabs
	const pendingCount = useMemo(() => {
		if (!datasets) return 0;
		const base = hasAboveMinId ? datasets.filter((d) => d.id > MIN_AUDIT_DATASET_ID) : datasets;
		return base.filter((d) => !d.is_audited && isProcessingComplete(d)).length;
	}, [datasets, hasAboveMinId]);

	const completedCount = useMemo(() => {
		if (!datasets) return 0;
		const base = hasAboveMinId ? datasets.filter((d) => d.id > MIN_AUDIT_DATASET_ID) : datasets;
		return base.filter((d) => d.is_audited).length;
	}, [datasets, hasAboveMinId]);

	const referenceCount = useMemo(() => {
		if (!datasets) return 0;
		return datasets.filter((d) => referenceDatasetIds.has(d.id)).length;
	}, [datasets, referenceDatasetIds]);

	const editsFlagsCount = useMemo(() => {
		if (!datasets) return 0;
		const flaggedSet = new Set(flaggedAgg.map((f) => f.dataset_id));
		return datasets.filter((d) => correctionsMap.has(d.id) || flaggedSet.has(d.id)).length;
	}, [datasets, flaggedAgg, correctionsMap]);

	// Check if user has audit privileges
	useEffect(() => {
		if (!isAuthLoading && !isAuditPrivilegeLoading && user && !canAudit) {
			message.error("You do not have permission to access this page");
			navigate("/");
		}
	}, [user, isAuthLoading, isAuditPrivilegeLoading, canAudit, navigate]);

	const handleStartAudit = async (datasetId: number) => {
		try {
			const { data, error } = await supabase
				.from("v2_statuses")
				.select("is_in_audit")
				.eq("dataset_id", datasetId)
				.single();

			if (error) {
				console.error("Error checking audit status:", error);
				navigate(`/dataset-audit/${datasetId}`);
				return;
			}

			if (data.is_in_audit) {
				message.warning("Dataset is currently being audited by another user");
				return;
			}

			track("audit_started", { dataset_id: datasetId });
			navigate(`/dataset-audit/${datasetId}`);
		} catch (error) {
			console.error("Error checking audit status:", error);
			track("audit_started", { dataset_id: datasetId });
			navigate(`/dataset-audit/${datasetId}`);
		}
	};

	useEffect(() => {
		track("audit_queue_viewed", { audit_tab: activeTab });
		if (activeTab === "edits-flags") {
			track("correction_review_started", { review_scope: "queue" });
		}
	}, [activeTab, track]);

	// Loading state
	if (isAuthLoading || isAuditPrivilegeLoading) {
		return <div className="p-6">Loading...</div>;
	}

	// Detail view
	if (id) {
		const dataset = datasets?.find((d) => d.id.toString() === id);
		if (isDatasetLoading) return <div>Loading dataset...</div>;
		if (!dataset) return <div>Dataset not found</div>;
		return <DatasetAuditDetail dataset={dataset} />;
	}

	const processingColumns: ColumnsType<ProcessingOverviewRow> = [
		{
			title: "ID",
			dataIndex: "dataset_id",
			key: "dataset_id",
			width: 90,
			defaultSortOrder: "descend",
			sorter: (a, b) => a.dataset_id - b.dataset_id,
		},
		{
			title: "File",
			dataIndex: "file_name",
			key: "file_name",
			width: 220,
			ellipsis: true,
			render: (value: string | null) => value || "—",
		},
		{
			title: "Processing",
			key: "processing_status",
			width: 170,
			render: (_, record) => {
				const status = record.processing_status || "UNKNOWN";
				const color =
					status === "PROCESSING"
						? "blue"
						: status === "QUEUED"
							? "orange"
							: status === "FAILED"
								? "red"
								: "green";
				return <Tag color={color} className="whitespace-nowrap">{status}</Tag>;
			},
		},
		{
			title: "Stage",
			dataIndex: "current_status",
			key: "current_status",
			width: 130,
			render: (value: string | null) => <Tag>{value || "idle"}</Tag>,
		},
		{
			title: "Stuck",
			key: "hours_in_current_status",
			width: 100,
			render: (_, record) => <span className="font-mono text-xs">{formatHours(record.hours_in_current_status)}</span>,
			sorter: (a, b) => (a.hours_in_current_status || 0) - (b.hours_in_current_status || 0),
		},
		{
			title: "Owner",
			dataIndex: "user_email",
			key: "user_email",
			width: 220,
			render: (value: string | null) => value || "—",
		},
		{
			title: "Queue",
			key: "queue",
			width: 90,
			render: (_, record) => (record.queue_priority === null ? "—" : `P${record.queue_priority}`),
		},
		{
			title: "Error",
			key: "error",
			width: 200,
			render: (_, record) => {
				if (!record.has_error) return <span className="text-gray-400">—</span>;
				const messageText = record.error_message || "Error";
				const shortText = messageText.length > 80 ? `${messageText.slice(0, 80)}...` : messageText;
				return (
					<Tooltip title={messageText}>
						<span className="text-red-600">{shortText}</span>
					</Tooltip>
				);
			},
		},
		{
			title: "Logs Preview",
			key: "logs_preview",
			width: 280,
			render: (_, record) => {
				if (!record.last_20_logs) return <span className="text-gray-400">No logs</span>;
				const preview = record.last_20_logs.split("\n").slice(0, 2).join("\n");
				return (
					<Tooltip title={record.last_20_logs}>
						<pre className="m-0 max-h-16 overflow-hidden whitespace-pre-wrap text-xs leading-tight">{preview}</pre>
					</Tooltip>
				);
			},
		},
		{
			title: "Actions",
			key: "actions",
			width: 120,
			render: (_, record) => (
				<Button size="small" onClick={() => setSelectedProcessingDatasetId(record.dataset_id)}>
					View Logs
				</Button>
			),
		},
	];

	// Build columns based on active tab
	const baseColumns: ColumnsType<IDataset> = [
		{
			title: "ID",
			dataIndex: "id",
			key: "id",
			sorter: (a, b) => a.id - b.id,
			defaultSortOrder: activeTab === "pending" ? undefined : "descend",
			width: 80,
		},
		{
			title: "Location",
			key: "location",
			render: (_, record) => (
				<Tooltip title={`${record.admin_level_3 || ""}, ${record.admin_level_2 || ""}, ${record.admin_level_1 || ""}`}>
					<span className="text-sm">{formatLocation(record)}</span>
				</Tooltip>
			),
			sorter: (a, b) => compareNullableStrings(formatLocation(a), formatLocation(b)),
			width: 180,
		},
		{
			title: "Biome",
			key: "biome",
			render: (_, record) => getBiomeBadge(record.biome_name),
			sorter: (a, b) => compareNullableStrings(a.biome_name, b.biome_name),
			width: 120,
		},
		{
			title: "Acquisition Date",
			key: "date",
			render: (_, record) => <span className="font-mono text-xs">{formatAcquisitionDate(record)}</span>,
			sorter: (a, b) => compareNullableNumbers(getAcquisitionDateSortKey(a), getAcquisitionDateSortKey(b)),
			width: 120,
		},
	];

	// Season column - only for Completed tab (season is determined during audit)
	const seasonColumn = {
		title: "Season",
		key: "season",
		render: (_: unknown, record: IDataset) => {
			const audit = auditMap.get(record.id);
			// has_valid_phenology: true = in season, false = out of season, null = not determined
			if (!audit || audit.has_valid_phenology === null) {
				return <Tag color="default">—</Tag>;
			}
			return audit.has_valid_phenology ? (
				<Tag color="green">In Season</Tag>
			) : (
				<Tag color="orange">Out of Season</Tag>
			);
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aAudit = auditMap.get(a.id);
			const bAudit = auditMap.get(b.id);
			const rank = (val: boolean | null | undefined) => {
				if (val === true) return 2;
				if (val === false) return 1;
				return 0; // unknown last-ish depending on sort order
			};
			return rank(aAudit?.has_valid_phenology ?? null) - rank(bAudit?.has_valid_phenology ?? null);
		},
		width: 100,
	};

	const pendingPhenologyProbabilityColumn = {
		title: "Phenology Prob.",
		key: "phenology_probability",
		render: (_: unknown, record: IDataset) => {
			const probability = pendingPhenologyProbabilityMap.get(record.id);
			if (typeof probability !== "number") {
				return <Tag color="default">—</Tag>;
			}

			const pct = Math.round(probability * 100);
			const color = pct >= 70 ? "green" : pct >= 40 ? "gold" : "red";
			return <Tag color={color}>{pct}%</Tag>;
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aProb = pendingPhenologyProbabilityMap.get(a.id);
			const bProb = pendingPhenologyProbabilityMap.get(b.id);
			const aValue = typeof aProb === "number" ? aProb : -1;
			const bValue = typeof bProb === "number" ? bProb : -1;
			return aValue - bValue;
		},
		width: 130,
	};

	// Notes/Description column - only for Completed tab
	const notesColumn = {
		title: "Notes",
		key: "notes",
		render: (_: unknown, record: IDataset) => {
			const audit = auditMap.get(record.id);
			const notes = audit?.notes;
			if (!notes) return <span className="text-gray-400">—</span>;
			const truncated = notes.length > 40 ? notes.slice(0, 40) + "..." : notes;
			return (
				<Tooltip title={notes}>
					<span className="text-sm text-gray-600 cursor-help">{truncated}</span>
				</Tooltip>
			);
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aNotes = auditMap.get(a.id)?.notes || "";
			const bNotes = auditMap.get(b.id)?.notes || "";
			return compareNullableStrings(aNotes, bNotes);
		},
		width: 200,
	};

	const flagsColumn = {
		title: "Flags",
		key: "flags",
		render: (_: unknown, record: IDataset) => {
			const flagData = flaggedMap.get(record.id);
			if (!flagData) return null;
			const openCount = flagData.open_count ?? 0;
			const acknowledgedCount = flagData.acknowledged_count ?? 0;
			const totalCount = openCount + acknowledgedCount;
			if (totalCount <= 0) return null;
			return (
				<Tooltip title={`${totalCount} flag(s) (open: ${openCount}, acknowledged: ${acknowledgedCount})`}>
					<Badge count={totalCount} size="small" overflowCount={BADGE_OVERFLOW_COUNT}>
						<FlagOutlined style={{ color: palette.state.warning }} />
					</Badge>
				</Tooltip>
			);
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aFlag = flaggedMap.get(a.id);
			const bFlag = flaggedMap.get(b.id);
			const aCount = (aFlag?.open_count ?? 0) + (aFlag?.acknowledged_count ?? 0);
			const bCount = (bFlag?.open_count ?? 0) + (bFlag?.acknowledged_count ?? 0);
			return aCount - bCount;
		},
		width: 70,
	};

	const correctionsColumn = {
		title: "Pending Edits",
		key: "corrections",
		render: (_: unknown, record: IDataset) => {
			const count = correctionsMap.get(record.id);
			if (!count) return <span className="text-gray-400">—</span>;
			return (
				<Tooltip title={`${count} pending polygon edit(s) awaiting review`}>
					<Badge count={count} size="small" color={palette.primary[500]} overflowCount={BADGE_OVERFLOW_COUNT}>
						<EditOutlined style={{ color: palette.primary[500] }} />
					</Badge>
				</Tooltip>
			);
		},
		sorter: (a: IDataset, b: IDataset) => (correctionsMap.get(a.id) || 0) - (correctionsMap.get(b.id) || 0),
		width: 100,
	};

	const contributorColumn = {
		title: "Contributor",
		key: "contributor",
		render: (_: unknown, record: IDataset) => {
			// First try contributor map, then fall back to audit map
			const email = contributorMap.get(record.id) || auditMap.get(record.id)?.uploaded_by_email;
			if (!email) return <span className="text-gray-400">—</span>;
			return (
				<Tooltip title="Click to copy email">
					<Button
						type="link"
						size="small"
						className="p-0 text-xs"
						onClick={() => {
							navigator.clipboard.writeText(email);
							message.success("Email copied to clipboard");
						}}
					>
						{email}
					</Button>
				</Tooltip>
			);
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aEmail = contributorMap.get(a.id) || auditMap.get(a.id)?.uploaded_by_email || "";
			const bEmail = contributorMap.get(b.id) || auditMap.get(b.id)?.uploaded_by_email || "";
			return compareNullableStrings(aEmail, bEmail);
		},
		width: 180,
	};

	const auditorColumn = {
		title: "Auditor",
		key: "auditor",
		render: (_: unknown, record: IDataset) => {
			const audit = auditMap.get(record.id);
			if (!audit?.audited_by_email) return <span className="text-gray-400">—</span>;
			return (
				<Tooltip title="Click to copy email">
					<Button
						type="link"
						size="small"
						className="p-0 text-xs"
						onClick={() => {
							navigator.clipboard.writeText(audit.audited_by_email!);
							message.success("Email copied to clipboard");
						}}
					>
						{audit.audited_by_email}
					</Button>
				</Tooltip>
			);
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aEmail = auditMap.get(a.id)?.audited_by_email || "";
			const bEmail = auditMap.get(b.id)?.audited_by_email || "";
			return compareNullableStrings(aEmail, bEmail);
		},
		width: 180,
	};

	const statusColumn = {
		title: "Status",
		key: "status",
		render: (_: unknown, record: IDataset) => {
			const audit = auditMap.get(record.id);
			if (!audit) return <Tag color="orange">Not audited yet</Tag>;

			const isReviewed = !!audit.reviewed_at;
			let statusTag;

			switch (audit.final_assessment) {
				case "no_issues":
					statusTag = <Tag color="green">✓ Ready</Tag>;
					break;
				case "fixable_issues":
					statusTag = <Tag color="yellow">🔧 Fixable</Tag>;
					break;
				case "exclude_completely":
					statusTag = <Tag color="red">🚫 Excluded</Tag>;
					break;
				default:
					statusTag = <Tag color="default">Unknown</Tag>;
			}

			return (
				<Space size="small">
					{statusTag}
					{isReviewed && (
						<Tooltip title={`Reviewed by ${audit.reviewed_by_email}`}>
							<Tag color="blue" className="text-xs">
								✓ Reviewed
							</Tag>
						</Tooltip>
					)}
				</Space>
			);
		},
		sorter: (a: IDataset, b: IDataset) => {
			const aAudit = auditMap.get(a.id);
			const bAudit = auditMap.get(b.id);

			const dispositionRank = (finalAssessment: DatasetAuditUserInfo["final_assessment"] | undefined | null) => {
				switch (finalAssessment) {
					case "no_issues":
						return 3;
					case "fixable_issues":
						return 2;
					case "exclude_completely":
						return 1;
					default:
						return 0;
				}
			};

			const aRank = dispositionRank(aAudit?.final_assessment ?? null);
			const bRank = dispositionRank(bAudit?.final_assessment ?? null);
			if (aRank !== bRank) return aRank - bRank;

			// Secondary: reviewed first/last depending on sort direction
			const aReviewed = aAudit?.reviewed_at ? 1 : 0;
			const bReviewed = bAudit?.reviewed_at ? 1 : 0;
			if (aReviewed !== bReviewed) return aReviewed - bReviewed;

			// Final tie-breaker: dataset id
			return a.id - b.id;
		},
		width: 180,
	};

	const actionsColumn = {
		title: "Actions",
		key: "actions",
		render: (_: unknown, record: IDataset) => {
			const isComplete = isProcessingComplete(record);
			const buttonLabel = record.is_audited ? "Review" : "Start Audit";
			const tooltipText = !isComplete
				? "Dataset processing must be complete before auditing"
				: record.is_audited
					? "Review this completed audit"
					: "Start audit for this dataset";
			return (
				<Tooltip title={tooltipText}>
					<Button type="primary" onClick={() => handleStartAudit(record.id)} disabled={!isComplete} size="small">
						{buttonLabel}
					</Button>
				</Tooltip>
			);
		},
		width: 120,
	};

	const referencePatchesColumn = {
		title: "Reference Patches",
		key: "reference_patches",
		render: (_: unknown, record: IDataset) => (
			<Tooltip title="Open Reference Patch Editor for this dataset">
				<Button size="small" onClick={() => navigate(`/dataset-audit/${record.id}/reference-patches`)}>
					{record.has_ml_tiles ? "Continue Patches" : "Generate Patches"}
				</Button>
			</Tooltip>
		),
		sorter: (a: IDataset, b: IDataset) => {
			const aHas = a.has_ml_tiles ? 1 : 0;
			const bHas = b.has_ml_tiles ? 1 : 0;
			if (aHas !== bHas) return aHas - bHas;
			return a.id - b.id;
		},
		width: 150,
	};

	// Assemble columns based on tab
	let columns: ColumnsType<IDataset>;
	if (activeTab === "pending") {
		// Pending: include derived phenology probability, flags and contributor
		columns = [...baseColumns, pendingPhenologyProbabilityColumn, flagsColumn, contributorColumn, actionsColumn];
	} else if (activeTab === "completed") {
		// Completed: season, notes, flags, status, auditor
		columns = [...baseColumns, seasonColumn, notesColumn, flagsColumn, statusColumn, auditorColumn, actionsColumn];
	} else if (activeTab === "edits-flags") {
		// Edits & Flags: show corrections and flags counts, with review action
		columns = [...baseColumns, correctionsColumn, flagsColumn, statusColumn, actionsColumn];
	} else {
		// Reference tab
		columns = [...baseColumns, referencePatchesColumn, actionsColumn];
	}

	const clearAllFilters = () => {
		setIdFilter("");
		setAcquisitionMonthRange(null);
		setBiomeFilter("");
		setCountryFilter("");
		setAuditorFilter("");
		setContributorFilter("");
		setHasFlagsFilter(false);
		setHasProcessingStates([]);
		setInSeasonOnly(false);
		setStatusFilter("all");
	};

	const hasActiveProcessingFilters = activeTab === "completed" && (hasProcessingStates.length > 0 || inSeasonOnly);

	const hasActiveFilters =
		idFilter ||
		Boolean(acquisitionMonthRange?.[0] || acquisitionMonthRange?.[1]) ||
		biomeFilter ||
		countryFilter ||
		auditorFilter ||
		contributorFilter ||
		hasFlagsFilter ||
		hasActiveProcessingFilters ||
		statusFilter !== "all";

	return (
		<div className="w-full bg-[#F8FAF9] min-h-[calc(100vh-64px)] pb-24 pt-24 md:pt-28">
			<div className="mx-auto max-w-[1920px] px-4 md:px-8 xl:px-12">
				{/* Header */}
				<div className="mb-8 flex items-center justify-between">
					<Title level={2} style={{ margin: 0, fontWeight: 700 }}>
						Dataset Audits
					</Title>
					<Button
						type="primary"
						ghost
						href="https://docs.google.com/document/d/1EQ52zDOU6X6ze1g-xKd381IPziv72Pt4QV18YDYqIUo/edit"
						target="_blank"
						rel="noopener noreferrer"
						icon={<span className="mr-1">📋</span>}
						className="shadow-sm"
					>
						Audit Protocol
					</Button>
				</div>

				{/* Tabs with badges */}
				<div className="mb-6">
					{isMobile ? (
						<Select
							value={activeTab}
							onChange={(value) => {
								setActiveTab(value as AuditTab);
								setStatusFilter("all");
							}}
							className="w-full"
							options={[
								{ label: `Pending (${pendingCount})`, value: "pending" },
								{ label: `Completed (${completedCount})`, value: "completed" },
								{ label: `Edits & Flags (${editsFlagsCount})`, value: "edits-flags" },
								{ label: `Reference (${referenceCount})`, value: "reference" },
								{ label: `Processing (${processingCount})`, value: "processing" },
							]}
						/>
					) : (
						<Segmented
							value={activeTab}
							onChange={(value) => {
								setActiveTab(value as AuditTab);
								setStatusFilter("all");
							}}
							className="shadow-sm border border-gray-200/50"
							options={[
							{
								label: (
									<Space size={6} className="py-1 px-2">
										<span>📋 Pending</span>
										<Badge count={pendingCount} size="small" color={palette.primary[500]} showZero overflowCount={BADGE_OVERFLOW_COUNT} />
									</Space>
								),
								value: "pending",
							},
							{
								label: (
									<Space size={6} className="py-1 px-2">
										<span>✓ Completed</span>
										<Badge count={completedCount} size="small" color={palette.state.success} showZero overflowCount={BADGE_OVERFLOW_COUNT} />
									</Space>
								),
								value: "completed",
							},
							{
								label: (
									<Space size={6} className="py-1 px-2">
										<span>🔔 Edits & Flags</span>
										<Badge count={editsFlagsCount} size="small" color={palette.state.warning} showZero overflowCount={BADGE_OVERFLOW_COUNT} />
									</Space>
								),
								value: "edits-flags",
							},
							{
								label: (
									<Space size={6} className="py-1 px-2">
										<span>📌 Reference</span>
										<Badge count={referenceCount} size="small" color={palette.secondary[500]} showZero overflowCount={BADGE_OVERFLOW_COUNT} />
									</Space>
								),
								value: "reference",
							},
							{
								label: (
									<Space size={6} className="py-1 px-2">
										<span>⚙️ Processing</span>
										<Badge count={processingCount} size="small" color={palette.state.warning} showZero overflowCount={BADGE_OVERFLOW_COUNT} />
									</Space>
								),
								value: "processing",
							},
							]}
							size="large"
						/>
					)}
				</div>

				<div className="rounded-2xl border border-gray-200/60 bg-white p-6 shadow-sm">
					{activeTab === "processing" && (
						<>
					<div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-gray-100 bg-gray-50 p-3">
						<div>
							<Text type="secondary" className="block mb-1 text-xs">
								Processing Status
							</Text>
							<Select
								mode="multiple"
								allowClear
								placeholder="Select statuses"
								style={{ width: isMobile ? 280 : 360 }}
								value={processingStatusFilters}
								onChange={(value) => setProcessingStatusFilters(value as ProcessingStatus[])}
								options={[
									{ label: "Processing", value: "PROCESSING" },
									{ label: "Queued", value: "QUEUED" },
									{ label: "Failed", value: "FAILED" },
									{ label: "Completed", value: "COMPLETED" },
								]}
							/>
						</div>
						<div>
							<Text type="secondary" className="block mb-1 text-xs">
								Stage
							</Text>
							<Select
								allowClear
								placeholder="All stages"
								style={{ width: isMobile ? 160 : 200 }}
								value={processingStageFilter}
								onChange={setProcessingStageFilter}
								options={processingStageOptions}
								showSearch
							/>
						</div>
						<div>
							<Text type="secondary" className="block mb-1 text-xs">
								Owner
							</Text>
							<Select
								allowClear
								placeholder="All owners"
								style={{ width: isMobile ? 220 : 260 }}
								value={processingUserFilter}
								onChange={setProcessingUserFilter}
								options={processingUserOptions}
								showSearch
							/>
						</div>
						<Space>
							<Button onClick={() => refetchProcessingRows()}>Refresh</Button>
							<Button
								onClick={() => {
									setProcessingStatusFilters(DEFAULT_PROCESSING_STATUS_FILTERS);
									setProcessingStageFilter(undefined);
									setProcessingUserFilter(undefined);
								}}
							>
								Reset
							</Button>
						</Space>
					</div>

					<Table
						dataSource={filteredProcessingRows}
						columns={processingColumns}
						rowKey="dataset_id"
						loading={isProcessingLoading}
						onRow={(record) => ({
							onClick: () => setSelectedProcessingDatasetId(record.dataset_id),
						})}
						pagination={{
							pageSize: 25,
							showSizeChanger: true,
							showQuickJumper: true,
							showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} datasets`,
						}}
						scroll={{ x: isMobile ? 980 : 1400 }}
					/>

					<Drawer
						title={`Dataset ${selectedProcessingDatasetId || ""} Logs`}
						open={selectedProcessingDatasetId !== null}
						onClose={() => setSelectedProcessingDatasetId(null)}
						width={isMobile ? "100%" : 820}
					>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
							<Space>
								<Text type="secondary">Log entries</Text>
								<Select
									value={logLimit}
									onChange={setLogLimit}
									style={{ width: 110 }}
									options={[
										{ label: "50", value: 50 },
										{ label: "100", value: 100 },
										{ label: "200", value: 200 },
									]}
								/>
							</Space>
							<Space>
								{selectedProcessingRow?.current_status && <Tag>{selectedProcessingRow.current_status}</Tag>}
								<Button onClick={() => refetchSelectedDatasetLogs()}>Refresh Logs</Button>
							</Space>
						</div>
						<Table
							rowKey="id"
							size="small"
							loading={isLogsLoading}
							dataSource={selectedDatasetLogs}
							pagination={false}
							columns={[
								{
									title: "Time",
									dataIndex: "created_at",
									key: "created_at",
									width: 170,
									render: (value: string) => new Date(value).toLocaleString(),
								},
								{
									title: "Level",
									dataIndex: "level",
									key: "level",
									width: 90,
									render: (value: string | null) => <Tag>{value || "INFO"}</Tag>,
								},
								{
									title: "Category",
									dataIndex: "category",
									key: "category",
									width: 140,
									render: (value: string | null) => value || "general",
								},
								{
									title: "Message",
									dataIndex: "message",
									key: "message",
									render: (value: string | null) => <span className="whitespace-pre-wrap text-xs">{value || ""}</span>,
								},
							]}
						/>
					</Drawer>
				</>
			)}

			{activeTab !== "processing" && (
				<>
					{/* Filters Panel */}
					<Collapse
						activeKey={filtersExpanded ? ["filters"] : []}
						onChange={() => setFiltersExpanded(!filtersExpanded)}
						className="mb-4"
						items={[
							{
								key: "filters",
								label: (
									<Space>
										<FilterOutlined />
										<span>Filters</span>
										{hasActiveFilters && (
											<Badge
												count={filteredDatasets.length}
												size="small"
												overflowCount={BADGE_OVERFLOW_COUNT}
												style={{ backgroundColor: palette.primary[500] }}
											/>
										)}
									</Space>
								),
								children: (
									<div className="space-y-4">
										{/* Row 1: Status, ID, Biome, Country */}
										<div className="flex flex-wrap gap-4">
											{activeTab === "completed" && (
												<div className="w-full md:w-auto">
													<Text type="secondary" className="block mb-1 text-xs">
														Status
													</Text>
													<Select
														value={statusFilter}
														onChange={setStatusFilter}
														style={{ width: isMobile ? "100%" : 150 }}
														options={[
															{ label: "All", value: "all" },
															{ label: "Ready", value: "ready" },
															{ label: "Fixable", value: "fixable" },
															{ label: "Excluded", value: "excluded" },
															{ label: "Needs Review", value: "needs-review" },
															{ label: "Reviewed", value: "reviewed" },
														]}
													/>
												</div>
											)}

											<div className="w-full md:w-auto">
												<Text type="secondary" className="block mb-1 text-xs">
													Dataset ID
												</Text>
												<Input
													placeholder="Filter by ID"
													prefix={<SearchOutlined />}
													value={idFilter}
													onChange={(e) => setIdFilter(e.target.value)}
													style={{ width: isMobile ? "100%" : 130 }}
													allowClear
												/>
											</div>

											<div className="w-full md:w-auto">
												<Text type="secondary" className="block mb-1 text-xs">
													Biome
												</Text>
												<Select
													value={biomeFilter}
													onChange={setBiomeFilter}
													style={{ width: isMobile ? "100%" : 200 }}
													allowClear
													placeholder="All biomes"
													showSearch
													options={uniqueBiomes.map((b) => ({ label: `${getBiomeEmoji(b)} ${b}`, value: b }))}
												/>
											</div>

											<div className="w-full md:w-auto">
												<Text type="secondary" className="block mb-1 text-xs">
													Country
												</Text>
												<Select
													value={countryFilter}
													onChange={setCountryFilter}
													style={{ width: isMobile ? "100%" : 180 }}
													allowClear
													placeholder="All countries"
													showSearch
													options={uniqueCountries.map((c) => ({ label: c, value: c }))}
												/>
											</div>

											{activeTab === "completed" && (
												<div className="w-full md:w-auto">
													<Text type="secondary" className="block mb-1 text-xs">
														Auditor
													</Text>
													<Select
														value={auditorFilter}
														onChange={setAuditorFilter}
														style={{ width: isMobile ? "100%" : 180 }}
														allowClear
														placeholder="All auditors"
														showSearch
														options={uniqueAuditors.map((a) => ({ label: a, value: a }))}
													/>
												</div>
											)}

											<div className="w-full md:w-auto">
												<Text type="secondary" className="block mb-1 text-xs">
													Contributor
												</Text>
												<Select
													value={contributorFilter}
													onChange={setContributorFilter}
													style={{ width: isMobile ? "100%" : 180 }}
													allowClear
													placeholder="All contributors"
													showSearch
													options={uniqueContributors.map((c) => ({ label: c, value: c }))}
												/>
											</div>

											<div className="w-full md:w-auto">
												<Text type="secondary" className="block mb-1 text-xs">
													Acquisition Month
												</Text>
												<DatePicker.RangePicker
													picker="month"
													value={acquisitionMonthRange}
													onChange={(value) => setAcquisitionMonthRange(value)}
													allowClear
													placeholder={["From", "To"]}
													style={{ width: isMobile ? "100%" : 200 }}
												/>
											</div>

										</div>

										{/* Row 2: Requirements */}
										<div className="rounded-md border border-gray-100 bg-gray-50 p-3">
											<div className="flex flex-wrap gap-6">
												<div>
													<Text type="secondary" className="block mb-1 text-xs">
														Has outputs
													</Text>
													<Checkbox.Group
														options={PROCESSING_STATE_OPTIONS}
														value={hasProcessingStates}
														onChange={(checkedValues) => setHasProcessingStates(checkedValues as ProcessingStateFilterKey[])}
													/>
												</div>
												<div>
													<Text type="secondary" className="block mb-1 text-xs">
														Season
													</Text>
													<div className="flex flex-row gap-1">

														<Checkbox checked={inSeasonOnly} onChange={(e) => setInSeasonOnly(e.target.checked)}>
															In season only
														</Checkbox>

													</div>

												</div>
												<div>
													<Text type="secondary" className="block mb-1 text-xs">
														Flags
													</Text>
													<div className="flex flex-row gap-1">
														<Checkbox checked={hasFlagsFilter} onChange={(e) => setHasFlagsFilter(e.target.checked)}>
															Has flags only
														</Checkbox>
													</div>

												</div>
											</div>
										</div>

										{/* Clear all button */}
										{hasActiveFilters && (
											<Button size="small" onClick={clearAllFilters}>
												Clear all filters
											</Button>
										)}
									</div>
								),
							},
						]}
					/>

					{/* Table */}
					<Table
						dataSource={sortedFilteredDatasets}
						columns={columns}
						rowKey="id"
						loading={isDatasetLoading || isAuditsLoading || isFlaggedLoading || isCorrectionsLoading || isPendingPhenologyLoading}
						pagination={{
							pageSize: 20,
							showSizeChanger: true,
							showQuickJumper: true,
							showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} datasets`,
						}}
						scroll={{ x: isMobile ? 860 : 1000 }}
					/>
				</>
			)}
			</div>
			</div>
		</div>
	);
}
