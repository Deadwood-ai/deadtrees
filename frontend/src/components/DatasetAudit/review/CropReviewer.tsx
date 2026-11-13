import { useMemo, useState, type ReactNode } from "react";
import { Button, Segmented, Tag } from "antd";
import { CheckOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditImage } from "../../../types/auditChecks";
import type { CropImageKind } from "../../../utils/auditChecks";
import { stepCrop } from "../../../utils/auditChecks";
import { LAYER_MODES, cropFindings, type PredictionLayer } from "../../../utils/cropCalls";
import {
	cantTell,
	cropAnswerRows,
	savedLayer,
	suggestedLayer,
	withProblem,
	withVerdict,
	type CropAnswerRow,
	type CropDraft,
	type ILayerDraft,
	type ProblemAnswer,
} from "../../../utils/cropAnswers";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";
import CropAnswerPanel, { PREDICTION_LABELS } from "./CropAnswerPanel";
import CropImages from "./CropImages";

/** A crop to review, in review order. */
export interface ICropReviewItem {
	id: number;
	/** the check counted it major: these come first, dashed and marked "!" */
	flagged: boolean;
}

export interface CropReviewerProps {
	crops: ICropReviewItem[];
	/** the prediction layers you answer on each crop: one per audit step, both in the benchmark */
	layers: PredictionLayer[];
	/** the crop's stored image: raw, or a layer's prediction over it */
	imageOf: (cropId: number, kind: CropImageKind) => IAuditImage | null;
	/** the models' rows: what they saw, and the problems that come ticked */
	automated: IAuditAssessment[];
	/** your latest row on a crop and layer ("image" holds "can't tell") */
	mine: (cropId: number, layer: AuditLayer) => IAuditAssessment | null;
	/** whether the check counted the crop major on a layer: then major is the suggestion */
	checkMajor?: (cropId: number, layer: PredictionLayer) => boolean | null;
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
	/** stores the rows of one crop; false when nothing was saved */
	onAnswer: (cropId: number, rows: CropAnswerRow[]) => Promise<boolean>;
	/** Enter once every crop has your answer: the next step */
	onDone?: () => void;
	/** B: the crop goes into the prediction benchmark (operators) */
	onAddToBenchmark?: (cropId: number) => void;
	/** M: back to the map for context */
	onShowMap?: () => void;
	/** above the images, e.g. the layer rating that follows from the crops */
	header?: ReactNode;
	/** the keys work: the reviewer is on screen */
	active: boolean;
	disabled: boolean;
	/** the models stay hidden until you answer: the benchmark labels blind */
	blind?: boolean;
}

const OVERLAY: Record<PredictionLayer, CropImageKind> = { deadwood: "deadwood_overlay", forest_cover: "forest_cover_overlay" };

/** The crop review: a crop large with its prediction, the strip of all crops, what the models saw
 * and your answer per error type. The audit's prediction steps and the benchmark use it alike.
 * Keys: ← → crops (flagged only until A), Tab next without your answer, T raw or prediction,
 * V side by side, ↑ ↓ error type, Y N U yes no unsure, 1 2 3 verdict (saves on the last layer),
 * Space layer fine, Shift+Space crop fine, C can't tell, Enter save and on, B benchmark, M map. */
export default function CropReviewer(props: CropReviewerProps) {
	const { crops, layers, imageOf, automated, mine, checkMajor, cropId, onSelectCrop, onAnswer, onDone, onAddToBenchmark, onShowMap, header, active, disabled, blind } =
		props;
	const [allCrops, setAllCrops] = useState(false);
	const [sideBySide, setSideBySide] = useState(true);
	const [showPrediction, setShowPrediction] = useState(true);
	const [saving, setSaving] = useState(false);
	// what you changed on a crop and not saved yet
	const [edits, setEdits] = useState<Map<number, CropDraft>>(new Map());
	const [focusIndex, setFocusIndex] = useState(0);

	const flagged = crops.filter((c) => c.flagged);
	const cyclingFlagged = !allCrops && flagged.length > 0;
	const cycle = cyclingFlagged ? flagged : crops;
	const index = crops.findIndex((c) => c.id === cropId);
	const crop = index >= 0 ? crops[index] : null;
	const answered = (id: number) => cantTell(mine(id, "image")) || layers.every((layer) => mine(id, layer));

	// the error types the arrow keys walk through, layer after layer
	const problems = useMemo(() => layers.flatMap((layer) => LAYER_MODES[layer].map((mode) => ({ layer, mode }))), [layers]);
	const focus = problems[Math.min(focusIndex, problems.length - 1)];

	/** Your answer on a crop's layers: what you saved, else the suggestion. */
	const savedOrSuggested = (id: number): CropDraft => ({
		assessable: true,
		layers: Object.fromEntries(
			layers.map((layer) => {
				const row = mine(id, layer);
				return [layer, row ? savedLayer(row) : suggestedLayer(automated, id, layer, checkMajor?.(id, layer) ?? null)];
			}),
		),
	});
	/** Your answer on a crop as it stands: what you changed, else "can't tell", else the layers. */
	const draftOf = (id: number): CropDraft => edits.get(id) ?? (cantTell(mine(id, "image")) ? { assessable: false } : savedOrSuggested(id));
	const draft = crop ? draftOf(crop.id) : null;
	const layerDraft = (layer: PredictionLayer): ILayerDraft =>
		draft?.assessable ? (draft.layers[layer] ?? { verdict: "ok", problems: {} }) : { verdict: "ok", problems: {} };
	const edit = (layer: PredictionLayer, change: (d: ILayerDraft) => ILayerDraft): CropDraft | null => {
		if (!crop || disabled) return null;
		const current = draftOf(crop.id);
		const next: CropDraft = { assessable: true, layers: { ...(current.assessable ? current.layers : {}), [layer]: change(layerDraft(layer)) } };
		setEdits((m) => new Map(m).set(crop.id, next));
		return next;
	};

	const goTo = (id: number | null) => {
		if (id === null) return;
		onSelectCrop(id);
		setFocusIndex(0);
	};
	const step = (by: 1 | -1) => goTo(stepCrop(cycle, cropId, by));
	/** The next crop of the cycle without your answer after this one, or null when you answered all. */
	const nextOpen = (): number | null => {
		const from = Math.max(0, cycle.findIndex((c) => c.id === cropId));
		for (let n = 1; n <= cycle.length; n++) {
			const c = cycle[(from + n) % cycle.length];
			if (c.id !== cropId && !answered(c.id)) return c.id;
		}
		return null;
	};

	/** Saves a crop's answer and goes to the next crop without one (or the next step). */
	const save = async (answer: CropDraft | null = draft) => {
		if (!crop || !answer || disabled || saving) return;
		setSaving(true);
		const saved = await onAnswer(crop.id, cropAnswerRows(answer)).finally(() => setSaving(false));
		if (!saved) return;
		setEdits((m) => {
			const rest = new Map(m);
			rest.delete(crop.id);
			return rest;
		});
		// after the last crop without your answer, stay: Enter then goes on to the next step
		const next = nextOpen();
		if (next !== null) goTo(next);
	};
	const verdictKey = (verdict: AuditVerdict) => () => {
		const layer = focus.layer;
		const next = edit(layer, (d) => withVerdict(d, verdict));
		// the last layer's verdict saves the crop; before it, go on to the next layer's questions
		if (layer === layers[layers.length - 1]) void save(next);
		else setFocusIndex(problems.findIndex((p) => p.layer === layers[layers.indexOf(layer) + 1]));
	};
	const problemKey = (answer: ProblemAnswer) => () => {
		edit(focus.layer, (d) => withProblem(d, focus.mode, answer));
		setFocusIndex((i) => Math.min(i + 1, problems.length - 1));
	};
	// Enter saves a crop you have not answered or changed since; on an answered one it goes on to
	// the next crop without your answer, and once there is none, to the next step
	const enter = () => {
		if (crop && (!answered(crop.id) || edits.has(crop.id))) return void save();
		const next = nextOpen();
		if (next !== null) goTo(next);
		else onDone?.();
	};
	const cropFine = () => {
		const fine: CropDraft = { assessable: true, layers: Object.fromEntries(layers.map((l) => [l, withVerdict(layerDraft(l), "ok")])) };
		void save(fine);
	};

	useAuditShortcuts(
		{
			ArrowRight: () => step(1),
			ArrowLeft: () => step(-1),
			Tab: () => goTo(nextOpen()),
			a: () => setAllCrops((all) => !all),
			// from side by side T shows the prediction alone, then switches raw and prediction
			t: () => {
				setShowPrediction((p) => (sideBySide ? true : !p));
				setSideBySide(false);
			},
			v: () => setSideBySide((s) => !s),
			ArrowDown: () => setFocusIndex((i) => Math.min(i + 1, problems.length - 1)),
			ArrowUp: () => setFocusIndex((i) => Math.max(i - 1, 0)),
			y: problemKey("yes"),
			n: problemKey("no"),
			u: problemKey("unsure"),
			"1": verdictKey("ok"),
			"2": verdictKey("minor"),
			"3": verdictKey("major"),
			" ": verdictKey("ok"),
			"shift+ ": cropFine,
			c: () => void save({ assessable: false }),
			Enter: enter,
			b: onAddToBenchmark && crop ? () => onAddToBenchmark(crop.id) : undefined,
			m: onShowMap,
		},
		active && !!crop,
	);
	// before a crop is picked, any of the crop keys starts with the first one
	useAuditShortcuts({ Enter: () => goTo(cycle[0]?.id ?? null), ArrowRight: () => goTo(cycle[0]?.id ?? null), m: onShowMap }, active && !crop);

	const flaggedCount = flagged.length;
	return (
		<div className="flex h-full min-h-0 w-full gap-3" data-testid="crop-reviewer">
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				{header}
				{crop && onDone && answered(crop.id) && !edits.has(crop.id) && nextOpen() === null && (
					<div className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-900" data-testid="crop-review-done">
						You answered all {cyclingFlagged ? "flagged " : ""}crops. Enter: next step{cyclingFlagged ? " · A: the other crops too" : ""}
					</div>
				)}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-1.5 text-sm font-semibold">
						<Button size="small" icon={<LeftOutlined />} aria-label="Previous crop" onClick={() => step(-1)} />
						<span data-testid="crop-position">{crop ? `Crop ${index + 1} of ${crops.length}` : `${crops.length} crops`}</span>
						<Button size="small" icon={<RightOutlined />} aria-label="Next crop" onClick={() => step(1)} />
						{crop?.flagged && (
							<Tag className="m-0 font-normal" color="orange">
								! check: major errors
							</Tag>
						)}
						{crop && answered(crop.id) && !edits.has(crop.id) && (
							<Tag className="m-0 font-normal" color="blue" icon={<CheckOutlined />}>
								answered
							</Tag>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						{flaggedCount > 0 && (
							<Segmented
								size="small"
								value={allCrops ? "all" : "flagged"}
								onChange={(v) => setAllCrops(v === "all")}
								options={[
									{ label: `Flagged (${flaggedCount})`, value: "flagged" },
									{ label: `All (${crops.length})`, value: "all" },
								]}
							/>
						)}
						<Segmented
							size="small"
							value={sideBySide ? "both" : showPrediction ? "prediction" : "raw"}
							onChange={(v) => {
								setSideBySide(v === "both");
								setShowPrediction(v !== "raw");
							}}
							options={[
								{ label: "Side by side (V)", value: "both" },
								{ label: "Raw", value: "raw" },
								{ label: "Prediction", value: "prediction" },
							]}
						/>
						{onShowMap && (
							<Button size="small" onClick={onShowMap}>
								Map (M)
							</Button>
						)}
					</div>
				</div>
				{crop ? (
					<CropImages
						raw={imageOf(crop.id, "raw")}
						prediction={imageOf(crop.id, OVERLAY[focus.layer])}
						predictionLabel={PREDICTION_LABELS[focus.layer]}
						sideBySide={sideBySide}
						showPrediction={showPrediction}
						resetKey={crop.id}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center">
						<Button type="primary" onClick={() => goTo(cycle[0]?.id ?? null)}>
							{flaggedCount ? `Start with the ${flaggedCount} flagged crops (Enter)` : `Start with crop 1 of ${crops.length} (Enter)`}
						</Button>
					</div>
				)}
				<CropStrip crops={crops} cropId={cropId} answered={answered} inCycle={(id) => cycle.some((c) => c.id === id)} onSelect={goTo} />
				<div className="text-[11px] text-gray-500">
					← → {cyclingFlagged ? "flagged " : ""}crops · A all or flagged · Tab next without your answer · T raw or prediction · V side by side · scroll to zoom
				</div>
			</div>
			<aside className="flex w-80 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-gray-100 pl-3">
				{crop && draft && !draft.assessable && (
					<div className="rounded bg-amber-50 p-2 text-xs text-amber-900">
						You said you can't tell what this crop shows. It does not count for the layer.{" "}
						<Button size="small" type="link" className="!p-0" onClick={() => setEdits((m) => new Map(m).set(crop.id, savedOrSuggested(crop.id)))}>
							Answer it after all
						</Button>
					</div>
				)}
				{crop &&
					draft?.assessable &&
					layers.map((layer) => (
						<CropAnswerPanel
							key={layer}
							layer={layer}
							findings={cropFindings({ automated }, crop.id, layer)}
							draft={layerDraft(layer)}
							focus={focus.layer === layer ? focus.mode : null}
							onFocus={(mode) => setFocusIndex(problems.findIndex((p) => p.layer === layer && p.mode === mode))}
							onProblem={(mode, answer) => edit(layer, (d) => withProblem(d, mode, answer))}
							onVerdict={(verdict) => edit(layer, (d) => withVerdict(d, verdict))}
							disabled={disabled || saving}
							blind={blind}
						/>
					))}
				{crop && (
					<div className="mt-auto flex flex-col gap-1.5 border-t border-gray-100 pt-2">
						<Button type="primary" block loading={saving} disabled={disabled} onClick={() => void save()} data-testid="crop-save">
							Save and next (Enter)
						</Button>
						<div className="flex gap-1.5">
							<Button size="small" className="flex-1" disabled={disabled || saving} onClick={cropFine}>
								All fine (Shift+Space)
							</Button>
							<Button size="small" className="flex-1" disabled={disabled || saving} onClick={() => void save({ assessable: false })}>
								Can't tell (C)
							</Button>
						</div>
						{onAddToBenchmark && (
							<Button size="small" disabled={disabled} onClick={() => onAddToBenchmark(crop.id)}>
								Add to benchmark (B)
							</Button>
						)}
						<div className="text-[11px] text-gray-500">↑ ↓ problem · Y / N / U yes, no, unsure · 1 2 3 verdict and save · Space fine and save</div>
					</div>
				)}
			</aside>
		</div>
	);
}

/** All crops at once: the flagged ones dashed orange with "!", yours ticked, the selected one filled. */
function CropStrip({
	crops,
	cropId,
	answered,
	inCycle,
	onSelect,
}: {
	crops: ICropReviewItem[];
	cropId: number | null;
	answered: (id: number) => boolean;
	inCycle: (id: number) => boolean;
	onSelect: (id: number) => void;
}) {
	return (
		<div className="flex flex-wrap gap-1" data-testid="crop-strip">
			{crops.map((c, i) => (
				<Button
					key={c.id}
					size="small"
					type={c.id === cropId ? "primary" : "default"}
					className={`!min-w-[2.25rem] ${c.flagged ? "!border-dashed !border-orange-500" : ""} ${inCycle(c.id) ? "" : "opacity-50"}`}
					aria-label={`Crop ${i + 1}${c.flagged ? ", flagged" : ""}${answered(c.id) ? ", answered" : ""}`}
					onClick={() => onSelect(c.id)}
				>
					{i + 1}
					{c.flagged ? " !" : ""}
					{answered(c.id) ? " ✓" : ""}
				</Button>
			))}
		</div>
	);
}
