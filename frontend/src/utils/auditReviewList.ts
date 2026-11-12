import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditQueueRow } from "../types/auditChecks";
import { AUDIT_SECTIONS, LAYER_LABELS, sectionOfCheck } from "./auditChecks";

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
	/** the result goes to a person; false when its version applies it without review */
	needsReview: boolean;
	/** you answered it on the current run */
	mine: boolean;
}

/** One dataset in the To review list, with a cell per target; a missing cell means the check has not run. */
export interface IDatasetReviewRow {
	datasetId: number;
	cells: Partial<Record<string, IReviewCell>>;
	/** every target has a result */
	complete: boolean;
	/** you answered every result of the dataset that goes to a person */
	finished: boolean;
	/** results that are not "ok" */
	problems: number;
	/** the check to open: the first one you have not answered, in audit page order */
	next: AuditCheckKey;
}

const targetKey = (checkKey: string, layer: string) => `${checkKey}:${layer}`;

/** A result's key in the answers lookup: "dataset:check:layer". */
export const reviewKey = (r: { dataset_id: number; check_key: string; layer: string }) => `${r.dataset_id}:${targetKey(r.check_key, r.layer)}`;

/** The targets the list has columns for, in audit page order: the layers of every check that has
 * at least one current result. A check that runs nowhere yet gets no column. */
export function reviewTargets(rows: Pick<IAuditQueueRow, "check_key" | "layer">[]): IReviewTarget[] {
	const present = new Set(rows.map((r) => targetKey(r.check_key, r.layer)));
	return AUDIT_SECTIONS.flatMap(({ checkKey, layers, title }) =>
		checkKey
			? layers
					.filter((layer) => present.has(targetKey(checkKey, layer)))
					.map((layer) => ({
						key: targetKey(checkKey, layer),
						checkKey,
						layer,
						title: layers.length > 1 ? (LAYER_LABELS[layer] ?? layer) : title,
					}))
			: [],
	);
}

/** Groups the current results (one per dataset, check and layer) into one row per dataset that
 * has a result going to a person, newest dataset first. `reviews` holds the answers per
 * "dataset:check:layer". */
export function datasetReviewRows(
	rows: IAuditQueueRow[],
	reviews: Record<string, { count: number; mine: boolean }>,
	targets: IReviewTarget[],
): IDatasetReviewRow[] {
	const byDataset = new Map<number, Partial<Record<string, IReviewCell>>>();
	for (const r of rows) {
		const cells = byDataset.get(r.dataset_id) ?? {};
		const answers = reviews[reviewKey(r)];
		cells[targetKey(r.check_key, r.layer)] = {
			verdict: r.verdict,
			needsReview: r.reason !== null,
			mine: !!answers?.mine,
		};
		byDataset.set(r.dataset_id, cells);
	}
	return [...byDataset.entries()]
		.sort(([a], [b]) => b - a)
		.flatMap(([datasetId, cells]) => {
			const results = targets.flatMap((target) => {
				const cell = cells[target.key];
				return cell ? [{ target, cell }] : [];
			});
			const toReview = results.filter((r) => r.cell.needsReview);
			if (!toReview.length) return [];
			const open = toReview.find((r) => !r.cell.mine);
			return [
				{
					datasetId,
					cells,
					complete: results.length === targets.length,
					finished: !open,
					problems: results.filter((r) => r.cell.verdict !== "ok").length,
					next: (open ?? toReview[0]).target.checkKey,
				},
			];
		});
}

/** The audit page link that opens a dataset on a check's section. */
export const reviewHref = (datasetId: number, checkKey: AuditCheckKey) => `/dataset-audit/${datasetId}?section=${sectionOfCheck(checkKey)}`;
