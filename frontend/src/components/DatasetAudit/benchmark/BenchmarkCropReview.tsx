import { useMemo } from "react";
import type { PredictionLayer, TileReviewInput } from "../../../types/auditChecks";
import { isLabeled, type ITileTarget } from "../../../utils/benchmarkLabels";
import CropReviewer from "../review/CropReviewer";
import LabeledBy from "./LabeledBy";

interface BenchmarkCropReviewProps {
	/** the layer the benchmark is on */
	layer: PredictionLayer;
	/** the tile targets to step through, in order */
	targets: ITileTarget[];
	current: ITileTarget | null;
	onSelect: (target: ITileTarget) => void;
	/** stores a tile's label; false when nothing was saved */
	onSave: (target: ITileTarget, review: TileReviewInput) => Promise<boolean>;
	/** a random new tile: on to another one without labeling this one */
	onSkip?: () => void;
}

/** A layer's benchmark in the audit's crop review, blind: the models' findings (and the problems
 * they would tick) show only on tiles that have a label. Each tile has one label, its newest
 * review whoever gave it; a new answer replaces it. */
export default function BenchmarkCropReview({ layer, targets, current, onSelect, onSave, onSkip }: BenchmarkCropReviewProps) {
	const byTile = useMemo(() => new Map(targets.map((t) => [t.tile_id, t])), [targets]);
	const judgements = useMemo(() => targets.filter(isLabeled).flatMap((t) => t.models), [targets]);
	const onAnswer = (tileId: number, answer: Pick<TileReviewInput, "verdict" | "problems">) => {
		const target = byTile.get(tileId);
		if (!target) return Promise.resolve(false);
		return onSave(target, { ...answer, dataset_id: target.dataset_id, tile_id: tileId, layer, prediction_label_id: target.prediction_label_id });
	};
	return (
		<CropReviewer
			crops={targets.map((t) => ({ id: t.tile_id, verdict: null }))}
			layer={layer}
			imageOf={(tileId, kind) => byTile.get(tileId)?.images.find((i) => i.kind === kind) ?? null}
			judgements={judgements}
			mine={(tileId) => byTile.get(tileId)?.label ?? null}
			cropId={current?.tile_id ?? null}
			onSelectCrop={(tileId) => {
				const target = byTile.get(tileId);
				if (target) onSelect(target);
			}}
			onAnswer={onAnswer}
			header={current && (current.label ? <LabeledBy review={current.label} /> : <div className="text-xs text-gray-500">Labeled blind: the models show once the crop has a label.</div>)}
			blind={!current || !isLabeled(current)}
			onSkip={onSkip}
			active
			disabled={false}
		/>
	);
}
