import { useMemo } from "react";
import { useAuditDatasets } from "../../../hooks/useAuditDatasets";
import { useAuditDatasetResults, useAuditReviewers } from "../../../hooks/useAuditDatasetResults";
import { useFlaggedDatasets } from "../../../hooks/useDatasetFlags";
import { usePendingCorrections } from "../../../hooks/usePendingCorrections";
import { useReferenceDatasetIds } from "../../../hooks/useReferencePatches";
import type { IAuditListRow } from "../../../utils/auditReviewList";

const NO_FLAGS: { dataset_id: number; open_count: number; acknowledged_count: number }[] = [];
const NO_CORRECTIONS = new Map<number, number>();
const NO_REFERENCES = new Set<number>();

/** Every dataset the auditor can see (not archived) with its check results, reviewers, user
 * reports, pending edits and reference selection: the rows of every Audit Review tab. */
export function useAuditListRows() {
	const datasets = useAuditDatasets();
	const results = useAuditDatasetResults();
	const { data: reviewers } = useAuditReviewers();
	const { data: flagged = NO_FLAGS } = useFlaggedDatasets();
	const { data: corrections = NO_CORRECTIONS } = usePendingCorrections();
	const { data: references = NO_REFERENCES } = useReferenceDatasetIds();

	const rows = useMemo<IAuditListRow[]>(() => {
		const byId = new Map((results.data?.rows ?? []).map((r) => [r.dataset_id, r]));
		const flags = new Map(flagged.map((f) => [f.dataset_id, (f.open_count ?? 0) + (f.acknowledged_count ?? 0)]));
		return (datasets.data ?? [])
			.filter((d) => !d.archived)
			.map((dataset) => ({
				id: dataset.id,
				dataset,
				result: byId.get(dataset.id) ?? null,
				reviewers: [...(reviewers?.get(dataset.id) ?? [])],
				flags: flags.get(dataset.id) ?? 0,
				edits: corrections.get(dataset.id) ?? 0,
				reference: references.has(dataset.id),
			}));
	}, [datasets.data, results.data, reviewers, flagged, corrections, references]);

	return {
		rows,
		isLoading: datasets.isLoading || results.isLoading,
		isError: datasets.isError,
		refetch: datasets.refetch,
		/** the check results can't be read: the rows show the datasets only */
		resultsUnavailable: results.isError || results.data?.available === false,
	};
}
