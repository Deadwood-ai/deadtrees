import { useQuery } from "@tanstack/react-query";
import { Settings } from "../config";
import type { IDataset } from "../types/dataset";
import { useAuth } from "./useAuthProvider";
import { supabase } from "./useSupabase";

const AUDIT_DATASET_FIELDS = [
	"id",
	"file_name",
	"archived",
	"aquisition_year",
	"aquisition_month",
	"aquisition_day",
	"admin_level_1",
	"admin_level_2",
	"admin_level_3",
	"biome_name",
	"has_ml_tiles",
] as const satisfies readonly (keyof IDataset)[];

const AUDIT_DATASET_SELECT = AUDIT_DATASET_FIELDS.join(",");

export type AuditDataset = Pick<IDataset, (typeof AUDIT_DATASET_FIELDS)[number]>;

/**
 * Lightweight dataset rows for the Audit Review list: where and when, the rest comes from
 * audit.dataset_outcomes.
 *
 * Keep this projection explicit: v2_full_dataset_view contains derived columns
 * that can be expensive or large, and the list loads every auditor-visible row.
 * Review detail routes fetch their single full dataset separately.
 */
export function useAuditDatasets() {
	const { status, user } = useAuth();

	return useQuery({
		queryKey: ["audit-datasets", status, user?.id ?? "anonymous"],
		queryFn: async () => {
			const { data, error } = await supabase
				.from(Settings.DATA_TABLE_FULL)
				.select(AUDIT_DATASET_SELECT)
				.overrideTypes<AuditDataset[], { merge: false }>();

			if (error) throw error;
			return data;
		},
		enabled: status !== "checking",
		retry: 1,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});
}
