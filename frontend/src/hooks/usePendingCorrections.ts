import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";

export interface DatasetCorrectionsCount {
	dataset_id: number;
	pending_count: number;
}

export interface CorrectionStats {
	pending: number;
	approved: number;
	rejected: number;
	total: number;
	pendingDeadwood?: number;
	pendingForestCover?: number;
}

export interface PendingCorrectionLocation {
	correctionId: number;
	geometryId: number;
	layerType: "deadwood" | "forest_cover";
	operation: string;
	centroidLon: number;
	centroidLat: number;
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

/**
 * Hook to fetch datasets that have pending geometry corrections.
 * Uses v2_full_dataset_view which computes counts server-side.
 * Returns a map of dataset_id -> pending_count for quick lookup.
 */
export function usePendingCorrections() {
	return useQuery({
		queryKey: ["pendingCorrections"],
		queryFn: async () => {
			// Query the view which has pre-computed correction counts
			const { data, error } = await supabase
				.from("v2_full_dataset_view")
				.select("id, pending_corrections_count")
				.gt("pending_corrections_count", 0);

			if (error) {
				console.error("Error fetching pending corrections:", error);
				throw error;
			}

			// Build map of dataset_id -> pending_count
			const countMap = new Map<number, number>();
			
			if (data) {
				data.forEach((row) => {
					countMap.set(row.id, row.pending_corrections_count);
				});
			}

			return countMap;
		},
		staleTime: 30000, // 30 seconds
	});
}

/**
 * Hook to get correction statistics for a specific dataset.
 * Returns pending, approved, rejected, and total counts.
 */
export function useCorrectionStats(datasetId: number | undefined) {
	return useQuery({
		queryKey: ["correctionStats", datasetId],
		queryFn: async (): Promise<CorrectionStats> => {
			if (!datasetId) {
				return { pending: 0, approved: 0, rejected: 0, total: 0 };
			}

			const { data, error } = await supabase
				.from("v2_full_dataset_view")
				.select("pending_corrections_count, approved_corrections_count, rejected_corrections_count, total_corrections_count")
				.eq("id", datasetId)
				.single();

			if (error) {
				console.error("Error fetching correction stats:", error);
				throw error;
			}

			return {
				pending: data?.pending_corrections_count ?? 0,
				approved: data?.approved_corrections_count ?? 0,
				rejected: data?.rejected_corrections_count ?? 0,
				total: data?.total_corrections_count ?? 0,
			};
		},
		enabled: !!datasetId,
		staleTime: 10000, // 10 seconds - shorter for detail view
	});
}

/**
 * Hook to get datasets that need review (have pending corrections or flags).
 * Combines correction data with flag data.
 */
export function useDatasetsNeedingReview() {
	const { data: correctionsMap, isLoading: isCorrectionsLoading } = usePendingCorrections();
	
	return {
		correctionsMap: correctionsMap ?? new Map<number, number>(),
		isLoading: isCorrectionsLoading,
	};
}

export interface CorrectionContributor {
	email: string;
	count: number;
}

/**
 * Hook to fetch pending corrections with contributor (user) information for a dataset.
 * Uses an RPC function that joins with auth.users to get emails securely.
 * Returns list of contributors with their email and correction counts.
 */
export function useCorrectionContributors(datasetId: number | undefined) {
	return useQuery({
		queryKey: ["correctionContributors", datasetId],
		queryFn: async (): Promise<CorrectionContributor[]> => {
			if (!datasetId) {
				return [];
			}

			// Use RPC function that securely joins with auth.users
			const { data, error } = await supabase.rpc("get_correction_contributors", {
				p_dataset_id: datasetId,
			});

			if (error) {
				console.error("Error fetching correction contributors:", error);
				return [];
			}

			if (!data || data.length === 0) {
				return [];
			}

			return data.map((row: { user_email: string; correction_count: number }) => ({
				email: row.user_email,
				count: row.correction_count,
			}));
		},
		enabled: !!datasetId,
		staleTime: 10000,
	});
}

/**
 * Hook to fetch pending correction locations for a dataset.
 * Returns list of pending corrections with their centroids and bounding boxes
 * for zooming/flashing functionality.
 */
export function usePendingCorrectionLocations(datasetId: number | undefined) {
	return useQuery({
		queryKey: ["pendingCorrectionLocations", datasetId],
		queryFn: async (): Promise<PendingCorrectionLocation[]> => {
			if (!datasetId) {
				return [];
			}

			const { data, error } = await supabase.rpc("get_pending_correction_locations", {
				p_dataset_id: datasetId,
			});

			if (error) {
				console.error("Error fetching pending correction locations:", error);
				return [];
			}

			if (!data || data.length === 0) {
				return [];
			}

			return data.map((row: {
				correction_id: number;
				geometry_id: number;
				layer_type: string;
				operation: string;
				centroid_lon: number;
				centroid_lat: number;
				min_lon: number;
				min_lat: number;
				max_lon: number;
				max_lat: number;
			}) => ({
				correctionId: row.correction_id,
				geometryId: row.geometry_id,
				layerType: row.layer_type as "deadwood" | "forest_cover",
				operation: row.operation,
				centroidLon: row.centroid_lon,
				centroidLat: row.centroid_lat,
				minLon: row.min_lon,
				minLat: row.min_lat,
				maxLon: row.max_lon,
				maxLat: row.max_lat,
			}));
		},
		enabled: !!datasetId,
		staleTime: 10000,
	});
}
