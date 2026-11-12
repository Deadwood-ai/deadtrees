import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditQueueRow } from "../types/auditChecks";
import { AUDIT_SECTIONS, LAYER_LABELS, auditSection, sectionOfCheck } from "./auditChecks";

/** One column of the To review list: a check on one layer, e.g. prediction quality on deadwood. */
export interface IReviewTarget {
	key: string;
	checkKey: AuditCheckKey;
	layer: AuditLayer;
	title: string;
}

/** A check result in a dataset's row, with who answered it on the current run. */
export interface IReviewCell {
	verdict: AuditVerdict;
	reviews: number;
	mine: boolean;
}

/** One dataset in the To review list, with a cell per target; a missing cell means the check has not run. */
export interface IDatasetReviewRow {
	datasetId: number;
	cells: Partial<Record<string, IReviewCell>>;
	/** every target has a result */
	complete: boolean;
	/** you answered every result the dataset has */
	finished: boolean;
	/** results that are not "ok" */
	problems: number;
	/** the check to open: the first one you have not answered, in audit page order */
	next: AuditCheckKey;
}

export const targetKey = (checkKey: string, layer: string) => `${checkKey}:${layer}`;

/** A result's key in the answers lookup: "dataset:check:layer". */
export const reviewKey = (r: { dataset_id: number; check_key: string; layer: string }) => `${r.dataset_id}:${targetKey(r.check_key, r.layer)}`;

/** The targets the list has columns for, in audit page order: the layers of every check that has
 * at least one result under review. A check that runs nowhere yet gets no column. */
export function reviewTargets(rows: Pick<IAuditQueueRow, "check_key" | "layer">[]): IReviewTarget[] {
	const present = new Set(rows.map((r) => targetKey(r.check_key, r.layer)));
	const checks = new Set(rows.map((r) => r.check_key));
	return AUDIT_SECTIONS.flatMap((section) =>
		section.checkKey && checks.has(section.checkKey)
			? section.layers
					.filter((layer) => section.layers.length === 1 || present.has(targetKey(section.checkKey!, layer)))
					.map((layer) => ({
						key: targetKey(section.checkKey!, layer),
						checkKey: section.checkKey!,
						layer,
						title: section.layers.length > 1 ? (LAYER_LABELS[layer] ?? layer) : auditSection(section.id).title,
					}))
			: [],
	);
}

/** Groups the queue's results (one per dataset, check and layer) into one row per dataset,
 * newest dataset first. `reviews` holds the answers per "dataset:check:layer". */
export function datasetReviewRows(
	rows: IAuditQueueRow[],
	reviews: Record<string, { count: number; mine: boolean }>,
	targets: IReviewTarget[],
): IDatasetReviewRow[] {
	const byDataset = new Map<number, Partial<Record<string, IReviewCell>>>();
	for (const r of rows) {
		const cells = byDataset.get(r.dataset_id) ?? {};
		const answers = reviews[reviewKey(r)];
		cells[targetKey(r.check_key, r.layer)] = { verdict: r.verdict, reviews: answers?.count ?? 0, mine: !!answers?.mine };
		byDataset.set(r.dataset_id, cells);
	}
	return [...byDataset.entries()]
		.sort(([a], [b]) => b - a)
		.map(([datasetId, cells]) => {
			const results = targets.filter((t) => cells[t.key]);
			const open = results.find((t) => !cells[t.key]!.mine);
			return {
				datasetId,
				cells,
				complete: results.length === targets.length,
				finished: !open,
				problems: results.filter((t) => cells[t.key]!.verdict !== "ok").length,
				next: (open ?? results[0] ?? targets[0]).checkKey,
			};
		});
}

/** The audit page link that opens a dataset on the check to answer next. */
export const reviewHref = (row: Pick<IDatasetReviewRow, "datasetId" | "next">) =>
	`/dataset-audit/${row.datasetId}?section=${sectionOfCheck(row.next)}`;
