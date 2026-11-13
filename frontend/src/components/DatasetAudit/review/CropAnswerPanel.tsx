import { Radio, Tag } from "antd";
import type { AuditVerdict } from "../../../types/auditChecks";
import { LAYER_MODES, MODE_LABELS, type ICropFinding, type PredictionLayer } from "../../../utils/cropCalls";
import type { ILayerDraft, ProblemAnswer } from "../../../utils/cropAnswers";

export const PREDICTION_LABELS: Record<PredictionLayer, string> = { deadwood: "Deadwood prediction", forest_cover: "Tree cover prediction" };

const VERDICTS: { value: AuditVerdict; label: string }[] = [
	{ value: "ok", label: "1 OK" },
	{ value: "minor", label: "2 Minor" },
	{ value: "major", label: "3 Major" },
];

const ANSWERS: { value: ProblemAnswer; label: string }[] = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
	{ value: "unsure", label: "?" },
];

const VERDICT_COLOR: Record<AuditVerdict, string> = { ok: "green", minor: "gold", major: "red", unsure: "default" };
const VERDICT_WORD: Record<AuditVerdict, string> = { ok: "OK", minor: "Minor", major: "Major", unsure: "Unsure" };

interface CropAnswerPanelProps {
	layer: PredictionLayer;
	findings: ICropFinding[];
	draft: ILayerDraft;
	/** the error type the keys answer (↑ ↓ move it), when it is on this layer */
	focus: string | null;
	onFocus: (mode: string) => void;
	onProblem: (mode: string, answer: ProblemAnswer) => void;
	onVerdict: (verdict: AuditVerdict) => void;
	disabled: boolean;
	/** the models stay hidden until you answer (the benchmark labels blind) */
	blind?: boolean;
}

/** One prediction layer of a crop: what each model saw, then your answer per error type (the
 * models' ones come ticked yes) and the crop's verdict on the layer. */
export default function CropAnswerPanel({ layer, findings, draft, focus, onFocus, onProblem, onVerdict, disabled, blind = false }: CropAnswerPanelProps) {
	// the share of the crop a model gave each error type, to weigh minor against major
	const area = (mode: string) => {
		const shares = findings.flatMap((f) => f.issues.filter((i) => i.key === mode && i.areaPct !== null).map((i) => i.areaPct as number));
		return shares.length ? Math.max(...shares) : null;
	};
	return (
		<div className="flex flex-col gap-3" data-testid={`crop-answer-${layer}`}>
			<div className="text-sm font-semibold">{PREDICTION_LABELS[layer]}</div>
			{blind ? <div className="text-[11px] text-gray-500">Models are shown after your answer.</div> : <Findings findings={findings} />}
			<div className="flex flex-col gap-1">
				<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{blind ? "Your answer" : "Your answer · the models' problems come ticked"}</div>
				{LAYER_MODES[layer].map((mode) => {
					const share = area(mode);
					return (
						<div
							key={mode}
							className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 ${focus === mode ? "bg-sky-50 ring-1 ring-sky-300" : ""}`}
							onClick={() => onFocus(mode)}
						>
							<span className="flex min-w-0 flex-col text-xs">
								{MODE_LABELS[mode]}
								{share !== null && <span className="text-[11px] text-gray-500">models: {share < 1 ? "<1" : Math.round(share)}% of the crop</span>}
							</span>
							<Radio.Group
								className="flex-shrink-0 whitespace-nowrap"
								size="small"
								optionType="button"
								buttonStyle="solid"
								value={draft.problems[mode] ?? "no"}
								disabled={disabled}
								aria-label={MODE_LABELS[mode]}
								onChange={(e) => onProblem(mode, e.target.value as ProblemAnswer)}
								options={ANSWERS}
							/>
						</div>
					);
				})}
			</div>
			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs font-medium">This crop</span>
					<Radio.Group
						size="small"
						optionType="button"
						buttonStyle="solid"
						value={draft.verdict}
						disabled={disabled}
						aria-label={`${PREDICTION_LABELS[layer]} on this crop`}
						onChange={(e) => onVerdict(e.target.value as AuditVerdict)}
						options={VERDICTS}
					/>
				</div>
				<div className="text-[11px] text-gray-500">Minor: under 20% of the crop's prediction is wrong. Major: 20% or more.</div>
			</div>
		</div>
	);
}

/** What each model saw in the crop: its call, the error types it found with their share of the
 * crop, and its own words. */
function Findings({ findings }: { findings: ICropFinding[] }) {
	if (!findings.length) return <div className="text-[11px] text-gray-500">No model judged this crop.</div>;
	return (
		<div className="flex flex-col gap-1.5" data-testid="audit-crop-findings">
			<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">What the models saw</div>
			{findings.map((f) => (
				<div key={f.model} className="text-xs">
					<span className="font-medium">{f.model}:</span>{" "}
					<Tag className="m-0 text-[11px]" color={VERDICT_COLOR[f.verdict]}>
						{VERDICT_WORD[f.verdict]}
					</Tag>
					{f.errors.map((e, n) => (
						<div key={n} className="mt-0.5 text-[11px] text-gray-600">
							“{e}”
						</div>
					))}
				</div>
			))}
		</div>
	);
}
