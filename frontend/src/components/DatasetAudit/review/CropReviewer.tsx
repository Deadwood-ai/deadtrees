import { useState, type ReactNode } from "react";
import { Button, Segmented, Slider, Tag } from "antd";
import { CheckOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditImage } from "../../../types/auditChecks";
import type { CropImageKind } from "../../../utils/auditChecks";
import { LAYER_LABELS, stepCrop } from "../../../utils/auditChecks";
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
import CropImage from "./CropImage";
import CropImages from "./CropImages";
import { usePredictionOpacity } from "./usePredictionOpacity";
import type { IBenchmarkToggle } from "../benchmark/useBenchmarkToggle";

/** A crop to review, in review order. */
export interface ICropReviewItem {
	id: number;
	/** the check's call on the crop; null when it has none (or the review is blind) */
	verdict: AuditVerdict | null;
}

export interface CropReviewerProps {
	crops: ICropReviewItem[];
	/** the prediction layer you answer on each crop: the audit step's, or the benchmark's */
	layer: PredictionLayer;
	/** the crop's stored image: raw, or a layer's prediction over it */
	imageOf: (cropId: number, kind: CropImageKind) => IAuditImage | null;
	/** the models' rows: what they saw, and the problems that come ticked */
	automated: IAuditAssessment[];
	/** the deciding model (a model name prefix): its verdict is the crop's call, the others are greyed */
	decider?: string;
	/** the answer a crop has on a layer ("image" holds "can't tell"): in the audit your latest row,
	 * in the benchmark the crop's label */
	mine: (cropId: number, layer: AuditLayer) => IAuditAssessment | null;
	/** whether the check counted the crop major: then major is the suggestion */
	checkMajor?: (cropId: number) => boolean | null;
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
	/** stores the rows of one crop; false when nothing was saved */
	onAnswer: (cropId: number, rows: CropAnswerRow[]) => Promise<boolean>;
	/** Enter once every crop has your answer: the next step */
	onDone?: () => void;
	/** B: the crop goes into the layer's benchmark or out of it again (operators) */
	benchmark?: Pick<IBenchmarkToggle, "isMember" | "toggle" | "pending">;
	/** M: back to the map for context */
	onShowMap?: () => void;
	/** above the images, e.g. the layer rating that follows from the crops */
	header?: ReactNode;
	/** the keys work: the reviewer is on screen */
	active: boolean;
	disabled: boolean;
	/** the models stay hidden until you answer: the benchmark labels blind */
	blind?: boolean;
	/** a random new benchmark tile: on to another one without labeling this one */
	onSkip?: () => void;
}

const OVERLAY: Record<PredictionLayer, CropImageKind> = { deadwood: "deadwood_overlay", forest_cover: "forest_cover_overlay" };

/** The strip's colours: OK green, minor amber, major red, ambiguous purple; nothing yet grey. */
const VERDICT_COLOR: Record<AuditVerdict, string> = { ok: "#16a34a", minor: "#f59e0b", major: "#dc2626", ambiguous: "#9333ea", unsure: "#9ca3af" };
const NO_CALL = "#d1d5db";

/** The crop review: a crop large with its prediction, the strip of all crops, what the models saw
 * and your answer per error type. The audit's prediction steps and the benchmark use it alike.
 * Keys: ← → crops, Tab next without your answer, T raw or prediction,
 * V side by side, - + prediction opacity (also [ ]), ↑ ↓ error type, Y N U yes no unsure, 1 2 3 4 decision and save,
 * Enter save and on, B benchmark in or out, M map. */
export default function CropReviewer(props: CropReviewerProps) {
	const { crops, layer, imageOf, automated, decider, mine, checkMajor, cropId, onSelectCrop, onAnswer, onDone, benchmark, onShowMap, header, active, disabled, blind, onSkip } =
		props;
	const [sideBySide, setSideBySide] = useState(true);
	const [showPrediction, setShowPrediction] = useState(true);
	const { opacity, setOpacity, weaker, stronger } = usePredictionOpacity();
	const [saving, setSaving] = useState(false);
	// what you changed on a crop and not saved yet
	const [edits, setEdits] = useState<Map<number, CropDraft>>(new Map());
	const [focusIndex, setFocusIndex] = useState(0);

	const index = crops.findIndex((c) => c.id === cropId);
	const crop = index >= 0 ? crops[index] : null;
	const answered = (id: number) => cantTell(mine(id, "image")) || !!mine(id, layer);

	// the error types the arrow keys walk through
	const problems: readonly string[] = LAYER_MODES[layer];
	const focus = problems[Math.min(focusIndex, problems.length - 1)];

	/** Your answer on a crop: what you saved, else the suggestion. */
	const savedOrSuggested = (id: number): CropDraft => {
		const row = mine(id, layer);
		return { assessable: true, layers: { [layer]: row ? savedLayer(row) : suggestedLayer(automated, id, layer, checkMajor?.(id) ?? null) } };
	};
	/** Your answer on a crop as it stands: what you changed, else "can't tell", else the layer. */
	const draftOf = (id: number): CropDraft => edits.get(id) ?? (cantTell(mine(id, "image")) ? { assessable: false } : savedOrSuggested(id));
	const draft = crop ? draftOf(crop.id) : null;
	const layerDraft: ILayerDraft = (draft?.assessable && draft.layers[layer]) || { verdict: "ok", problems: {} };
	const edit = (change: (d: ILayerDraft) => ILayerDraft): CropDraft | null => {
		if (!crop || disabled) return null;
		const next: CropDraft = { assessable: true, layers: { [layer]: change(layerDraft) } };
		setEdits((m) => new Map(m).set(crop.id, next));
		return next;
	};

	const goTo = (id: number | null) => {
		if (id === null) return;
		onSelectCrop(id);
		setFocusIndex(0);
	};
	const step = (by: 1 | -1) => goTo(stepCrop(crops, cropId, by));
	/** The next crop without your answer after this one, or null when you answered all. */
	const nextOpen = (): number | null => {
		const from = Math.max(0, crops.findIndex((c) => c.id === cropId));
		for (let n = 1; n <= crops.length; n++) {
			const c = crops[(from + n) % crops.length];
			if (c.id !== cropId && !answered(c.id)) return c.id;
		}
		return null;
	};

	/** Stores a crop's answer; false when nothing was saved. */
	const store = async (answer: CropDraft | null = draft) => {
		if (!crop || !answer || disabled || saving) return false;
		setSaving(true);
		const saved = await onAnswer(crop.id, cropAnswerRows(answer)).finally(() => setSaving(false));
		if (saved)
			setEdits((m) => {
				const rest = new Map(m);
				rest.delete(crop.id);
				return rest;
			});
		return saved;
	};
	/** Saves a crop's answer and goes to the next crop without one (or the next step). */
	const save = async (answer: CropDraft | null = draft) => {
		if (!(await store(answer))) return;
		// after the last crop without your answer, stay: Enter then goes on to the next step
		const next = nextOpen();
		if (next !== null) goTo(next);
	};
	/** B: the crop goes into the benchmark labeled with your answer, which is saved first when it is
	 * not yet, or out of it again. */
	const toggleBenchmark = async () => {
		if (!benchmark || !crop) return;
		if (!benchmark.isMember(crop.id) && (!answered(crop.id) || edits.has(crop.id)) && !(await store())) return;
		await benchmark.toggle(crop.id);
	};
	/** A crop's colour in the strip: your answer, else the check's call (the deciding model's
	 * verdict). Blind: nothing before your answer. */
	const stripColor = (id: number): string => {
		const own = mine(id, layer);
		if (cantTell(mine(id, "image"))) return VERDICT_COLOR.unsure;
		if (own?.verdict) return VERDICT_COLOR[own.verdict];
		const call = blind ? null : crops.find((c) => c.id === id)?.verdict;
		return call ? VERDICT_COLOR[call] : NO_CALL;
	};
	// one crop alone (a random benchmark tile) has nothing to step through
	const several = crops.length > 1;
	const benchmarkName = `${LAYER_LABELS[layer]!.toLowerCase()} benchmark`;
	/** A verdict saves the crop. */
	const verdictKey = (verdict: AuditVerdict) => () => void save(edit((d) => withVerdict(d, verdict)));
	const problemKey = (answer: ProblemAnswer) => () => {
		edit((d) => withProblem(d, focus, answer));
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

	useAuditShortcuts(
		{
			ArrowRight: () => step(1),
			ArrowLeft: () => step(-1),
			Tab: () => goTo(nextOpen()),
			// from side by side T shows the prediction alone, then switches raw and prediction
			t: () => {
				setShowPrediction((p) => (sideBySide ? true : !p));
				setSideBySide(false);
			},
			v: () => setSideBySide((s) => !s),
			// - and + work on every layout; [ and ] need AltGr or Option on German keyboards
			"-": weaker,
			"+": stronger,
			"=": stronger,
			"[": weaker,
			"]": stronger,
			ArrowDown: () => setFocusIndex((i) => Math.min(i + 1, problems.length - 1)),
			ArrowUp: () => setFocusIndex((i) => Math.max(i - 1, 0)),
			y: problemKey("yes"),
			n: problemKey("no"),
			u: problemKey("unsure"),
			"1": verdictKey("ok"),
			"2": verdictKey("minor"),
			"3": verdictKey("major"),
			"4": verdictKey("ambiguous"),
			Enter: enter,
			b: benchmark && crop ? () => void toggleBenchmark() : undefined,
			m: onShowMap,
		},
		active && !!crop,
	);
	// before a crop is picked, any of the crop keys starts with the first one
	useAuditShortcuts({ Enter: () => goTo(crops[0]?.id ?? null), ArrowRight: () => goTo(crops[0]?.id ?? null), m: onShowMap }, active && !crop);

	return (
		<div className="flex h-full min-h-0 w-full gap-3" data-testid="crop-reviewer">
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				{header}
				{crop && onDone && answered(crop.id) && !edits.has(crop.id) && nextOpen() === null && (
					<div className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-900" data-testid="crop-review-done">
						You answered all crops. Enter: next step
					</div>
				)}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-1.5 text-sm font-semibold">
						{several && (
							<>
								<Button size="small" icon={<LeftOutlined />} aria-label="Previous crop" onClick={() => step(-1)} />
								<span data-testid="crop-position">{crop ? `Crop ${index + 1} of ${crops.length}` : `${crops.length} crops`}</span>
								<Button size="small" icon={<RightOutlined />} aria-label="Next crop" onClick={() => step(1)} />
							</>
						)}
						{crop && answered(crop.id) && !edits.has(crop.id) && (
							<Tag className="m-0 font-normal" color="blue" icon={<CheckOutlined />}>
								answered
							</Tag>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						{/* first and always in place (hidden on the raw image), so the buttons never move */}
						<label
							className={`flex items-center gap-1.5 text-xs text-gray-600 ${sideBySide || showPrediction ? "" : "invisible"}`}
							title="How strongly the prediction shows over the raw image (- and +)"
						>
							Prediction
							<Slider
								className="!my-0 w-24"
								min={0}
								max={100}
								step={10}
								// the arrow keys stay with the crops
								keyboard={false}
								value={Math.round(opacity * 100)}
								onChange={(v) => setOpacity(v / 100)}
								tooltip={{ formatter: (v) => `${v}%` }}
								aria-label="Prediction opacity"
								data-testid="crop-prediction-opacity"
							/>
							<span className="w-8 tabular-nums">{Math.round(opacity * 100)}%</span>
						</label>
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
						prediction={imageOf(crop.id, OVERLAY[layer])}
						predictionLabel={PREDICTION_LABELS[layer]}
						sideBySide={sideBySide}
						showPrediction={showPrediction}
						opacity={opacity}
						resetKey={crop.id}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center">
						<Button type="primary" onClick={() => goTo(crops[0]?.id ?? null)}>
							Start with crop 1 of {crops.length} (Enter)
						</Button>
					</div>
				)}
				{/* the next crop's images load while you answer this one */}
				<div hidden>
					{crop &&
						[nextOpen() ?? stepCrop(crops, cropId, 1)].flatMap((id) =>
							id === null || id === crop.id
								? []
								: [imageOf(id, "raw"), imageOf(id, OVERLAY[layer])].flatMap((image) => (image ? [<CropImage key={image.id} image={image} />] : [])),
						)}
				</div>
				{several && <CropStrip crops={crops} cropId={cropId} color={stripColor} answered={answered} onSelect={goTo} />}
				<div className="text-[11px] text-gray-500">
					{several && <>← → crops · Tab next without your answer · </>}T raw or prediction · V side by side · - + prediction opacity · scroll to zoom
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
				{crop && draft?.assessable && (
					<CropAnswerPanel
						layer={layer}
						findings={cropFindings({ automated }, crop.id, layer, decider)}
						draft={layerDraft}
						focus={focus}
						onFocus={(mode) => setFocusIndex(problems.indexOf(mode))}
						onProblem={(mode, answer) => edit((d) => withProblem(d, mode, answer))}
						onVerdict={(verdict) => edit((d) => withVerdict(d, verdict))}
						disabled={disabled || saving}
						blind={blind}
						benchmark={{
							member: benchmark ? benchmark.isMember(crop.id) : null,
							onToggle: () => void toggleBenchmark(),
							disabled: disabled || saving || !!benchmark?.pending,
							name: benchmarkName,
						}}
					/>
				)}
				{crop && (
					<div className="mt-auto flex flex-col gap-1.5 border-t border-gray-100 pt-2">
						{onSkip && (
							<Button block disabled={disabled || saving} onClick={onSkip} data-testid="benchmark-skip">
								Skip (K)
							</Button>
						)}
						<Button type="primary" block loading={saving} disabled={disabled} onClick={() => void save()} data-testid="crop-save">
							Save and next (Enter)
						</Button>
						<div className="text-[11px] text-gray-500">↑ ↓ problem · Y / N / U yes, no, unsure · 1 2 3 4 decision and save</div>
					</div>
				)}
			</aside>
		</div>
	);
}

/** All crops at once, coloured by decision; the selected one ringed. */
function CropStrip({
	crops,
	cropId,
	color,
	answered,
	onSelect,
}: {
	crops: ICropReviewItem[];
	cropId: number | null;
	color: (id: number) => string;
	answered: (id: number) => boolean;
	onSelect: (id: number) => void;
}) {
	return (
		<div className="flex flex-wrap gap-1" data-testid="crop-strip">
			{crops.map((c, i) => {
				const background = color(c.id);
				const mine = answered(c.id);
				return (
					<button
						key={c.id}
						type="button"
						className={`h-6 min-w-[2.25rem] rounded border-0 px-1.5 text-xs font-medium ${background === NO_CALL ? "text-gray-700" : "text-white"} ${
							c.id === cropId ? "ring-2 ring-gray-900 ring-offset-1" : ""
						}`}
						style={{ background }}
						aria-label={`Crop ${i + 1}${mine ? ", answered" : ""}`}
						aria-current={c.id === cropId}
						onClick={() => onSelect(c.id)}
					>
						{i + 1}
					</button>
				);
			})}
		</div>
	);
}
