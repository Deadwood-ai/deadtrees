/** Benchmarks (docs/playbooks/audit-and-benchmarks.md): a benchmark is the set of people's
 * reviews ticked in_benchmark, per check and layer. A target's label is its newest review,
 * whoever gave it. */

import type { IDatasetJudgement, IDatasetReview, IAuditImage, ITileJudgement, ITileReview, PredictionLayer } from "../types/auditChecks";

export type BenchmarkKey = "deadwood" | "forest_cover" | "dataset_evaluation";

/** The benchmarks people label, in the order the tab lists them: prediction quality has one per
 * layer. The key names the benchmark in the labeling page's URL and in audit.draw_target. */
export const BENCHMARKS: { key: BenchmarkKey; layer: PredictionLayer | null; title: string }[] = [
	{ key: "deadwood", layer: "deadwood", title: "Deadwood prediction" },
	{ key: "forest_cover", layer: "forest_cover", title: "Tree cover prediction" },
	{ key: "dataset_evaluation", layer: null, title: "Dataset evaluation" },
];

interface ITargetBase {
	/** the tile id on a tile benchmark, else the dataset id */
	id: number;
	dataset_id: number;
	/** what the labeler sees: a tile's raw image and overlays, or a dataset's overview, thumbnail and tiles */
	images: IAuditImage[];
}

/** A dataset of the dataset evaluation benchmark, or a random new one. */
export interface IDatasetTarget extends ITargetBase {
	tile_id: null;
	/** the newest dataset evaluation review; null on a random new dataset */
	label: IDatasetReview | null;
	models: IDatasetJudgement[];
}

/** A tile of a layer's benchmark, or a random new one. */
export interface ITileTarget extends ITargetBase {
	tile_id: number;
	/** the newest review of the tile on the layer; null on a random new tile */
	label: ITileReview | null;
	models: ITileJudgement[];
	/** the prediction the overlay shows, which a label judges */
	prediction_label_id: number | null;
}

export type IBenchmarkTarget = IDatasetTarget | ITileTarget;

/** The labeling page's two modes: label random new targets, or review the existing labels. */
export type BenchmarkMode = "new" | "review";

/** A target's key in the page's URL. */
export const targetKey = (t: { dataset_id: number; tile_id: number | null }) => (t.tile_id !== null ? `tile-${t.tile_id}` : `dataset-${t.dataset_id}`);

/** What a benchmark's targets are called: tiles, or datasets. */
export const targetNoun = (tiles: boolean, n = 2) => `${tiles ? "tile" : "dataset"}${n === 1 ? "" : "s"}`;

/** Whether the target has its label. */
export const isLabeled = (target: { label: unknown }) => target.label !== null;

/** Targets stratified across datasets: the first target of each dataset, then the second of
 * each, and so on, so labeling in order covers every dataset before it takes a second tile
 * of one. */
export function stratified<T extends { dataset_id: number }>(targets: T[]): T[] {
	const byDataset = new Map<number, T[]>();
	for (const t of targets) byDataset.set(t.dataset_id, [...(byDataset.get(t.dataset_id) ?? []), t]);
	const groups = [...byDataset.values()];
	const rounds = Math.max(0, ...groups.map((g) => g.length));
	return Array.from({ length: rounds }, (_, round) => groups.flatMap((g) => (round < g.length ? [g[round]] : []))).flat();
}

/** The images a labeler sees of a tile: of the newest run that cut its layer's overlay, the raw
 * image and the overlay, preferring the overlay of the prediction the label judged (so a label
 * keeps its picture after a rerun). */
export function tileImages(images: IAuditImage[], layer: PredictionLayer, labelPrediction: number | null | undefined): IAuditImage[] {
	const kind = layer === "deadwood" ? "deadwood_overlay" : "forest_cover_overlay";
	const overlays = images.filter((i) => i.kind === kind).sort((a, b) => b.id - a.id);
	const overlay = overlays.find((i) => i.prediction_label_id === labelPrediction) ?? overlays[0];
	if (!overlay) return images.filter((i) => i.kind === "raw").slice(-1);
	return images.filter((i) => i.run_id === overlay.run_id && (i.kind === "raw" || i.id === overlay.id));
}
