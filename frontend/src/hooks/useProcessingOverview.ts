import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";

export type ProcessingStatus = "PROCESSING" | "QUEUED" | "FAILED" | "COMPLETED";

export interface ProcessingOverviewRow {
	dataset_id: number;
	file_name: string | null;
	processing_status: ProcessingStatus | string | null;
	current_status: string | null;
	has_error: boolean | null;
	error_message: string | null;
	hours_in_current_status: number | null;
	status_last_updated: string | null;
	user_email: string | null;
	queue_priority: number | null;
	queued_at: string | null;
	is_upload_done: boolean | null;
	is_odm_done: boolean | null;
	is_ortho_done: boolean | null;
	is_cog_done: boolean | null;
	is_thumbnail_done: boolean | null;
	is_metadata_done: boolean | null;
	is_deadwood_done: boolean | null;
	is_forest_cover_done: boolean | null;
	last_20_logs: string | null;
}

export interface DatasetLogRow {
	id: number;
	created_at: string;
	level: string | null;
	category: string | null;
	message: string | null;
	origin: string | null;
	origin_line: number | null;
}

export function useProcessingOverview() {
	const { user } = useAuth();
	const { canAudit } = useCanAudit();

	return useQuery({
		queryKey: ["processing-overview"],
		enabled: !!user?.id && canAudit,
		queryFn: async () => {
			const { data, error } = await supabase.from("v2_processing_overview").select("*");
			if (error) throw error;
			return (data || []) as ProcessingOverviewRow[];
		},
		staleTime: 60 * 1000,
	});
}

export function useDatasetLogs(datasetId: number | null, limit: number) {
	const { user } = useAuth();
	const { canAudit } = useCanAudit();

	return useQuery({
		queryKey: ["processing-logs", datasetId, limit],
		enabled: !!datasetId && !!user?.id && canAudit,
		queryFn: async () => {
			if (!datasetId) return [];
			const { data, error } = await supabase
				.from("v2_logs")
				.select("id, created_at, level, category, message, origin, origin_line")
				.eq("dataset_id", datasetId)
				.order("created_at", { ascending: false })
				.limit(limit);
			if (error) throw error;
			return (data || []) as DatasetLogRow[];
		},
		staleTime: 10 * 1000,
	});
}
