import { Form, Image, Input, Radio, Tag, message } from "antd";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { EvaluationDecision, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import { EXCLUDE_REASONS, automatedRows, reviewAnswer } from "../../../utils/auditChecks";
import { modelName } from "../../../utils/cropCalls";
import { DECISION_LABELS, decisionOfVerdict, evaluationAnswer, type IReviewContext, type IReviewDraft } from "../../../utils/auditReview";
import BenchmarkToggle from "../benchmark/BenchmarkToggle";
import ChoiceRow, { YES_NO } from "./ChoiceRow";
import CogFacts, { type CogFactsProps } from "./CogFacts";

interface EvaluationStepProps {
	/** the dataset evaluation's current run, when it has one */
	evidence: IAuditCheckEvidence | undefined;
	people: IAuditAssessment[];
	cog: CogFactsProps;
	thumbnailUrl: string | null;
	/** the dataset and its current runs, for the benchmark label */
	review: Pick<IReviewContext, "datasetId" | "runs">;
	/** B adds the dataset to the benchmark while the step is open */
	active: boolean;
}

const DECISIONS = (["ok", "exclude"] as EvaluationDecision[]).map((d) => ({ label: DECISION_LABELS[d], value: d }));
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A small heading inside a step. */
export const StepHeading = ({ children }: { children: string }) => (
	<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{children}</div>
);

/** One answer of the evaluation in words: "OK", "Exclude (blurry)" or "Unsure". */
function answerWords(row: IAuditAssessment): string {
	const decision = decisionOfVerdict(row.verdict);
	if (!decision) return "Unsure";
	const reason = decision === "exclude" ? EXCLUDE_REASONS.find((r) => r.code === row.details.reason)?.label : null;
	return reason ? `${DECISION_LABELS[decision]} (${reason.toLowerCase()})` : DECISION_LABELS[decision];
}

/** Step 1: the map image (COG) and the thumbnail, each with its facts and an issue (yes or no),
 * then the dataset's decision: OK or Exclude. Both issues are output values, independent of the
 * decision; the form starts with the current values and Save stores what you change. Operators add the
 * dataset to the dataset evaluation benchmark here, labeled with the decision. */
export default function EvaluationStep({ evidence, people, cog, thumbnailUrl, review, active }: EvaluationStepProps) {
	const form = Form.useFormInstance<IReviewDraft>();
	const decision = Form.useWatch("decision", form);
	const { mutateAsync: saveAnswers } = useSaveAuditAnswers();
	// each model's answer and reasoning; the rule's only where no model answered (e.g. no valid pixels)
	const automated = automatedRows(evidence, "image");
	const models = automated.filter((a) => a.assessor_kind === "model");
	const said = models.length ? models : automated.slice(0, 1);
	// the model whose answer is the check's decision (the rule row names it, else Haiku); the others are shown only
	const named = automated.find((a) => a.assessor_kind === "rule")?.details.decider;
	const decides = (model: string | null) => !!model && model.startsWith(typeof named === "string" ? named : "haiku");

	/** The benchmark keeps your decision as the dataset's label: stored now, unless your latest
	 * answer on the run already says it. */
	const storeLabel = async () => {
		const answer = evaluationAnswer(form.getFieldsValue(true), review);
		const problem = !answer ? "Pick OK or Exclude first: it is the dataset's label in the benchmark." : answer.problems[0];
		if (!answer || problem) {
			message.error(problem);
			return false;
		}
		const mine = reviewAnswer(people, answer.row.run_id ?? undefined, { checkKey: "dataset_evaluation", layer: "image", cropId: null });
		if (mine && mine.verdict === answer.row.verdict && mine.reason_code === answer.row.reason_code) return true;
		try {
			await saveAnswers([answer.row]);
			return true;
		} catch {
			message.error("Your decision was not saved, so the dataset was not added to the benchmark.");
			return false;
		}
	};

	return (
		<div className="flex flex-col gap-3" data-testid="audit-evaluation-step">
			<section data-testid="audit-cog">
				<StepHeading>Map image (COG)</StepHeading>
				<CogFacts {...cog} />
				<ChoiceRow label="COG issue">
					<Form.Item name="cogIssue" noStyle>
						<Radio.Group options={YES_NO} optionType="button" buttonStyle="solid" size="small" aria-label="COG issue" />
					</Form.Item>
				</ChoiceRow>
			</section>

			<section data-testid="audit-thumbnail">
				<StepHeading>Thumbnail</StepHeading>
				{thumbnailUrl ? (
					<Image src={thumbnailUrl} alt="Dataset thumbnail" width={72} height={72} style={{ objectFit: "cover" }} className="rounded border" />
				) : (
					<div className="text-xs text-gray-500">No thumbnail yet</div>
				)}
				<ChoiceRow label="Thumbnail issue">
					<Form.Item name="thumbnailIssue" noStyle>
						<Radio.Group options={YES_NO} optionType="button" buttonStyle="solid" size="small" aria-label="Thumbnail issue" />
					</Form.Item>
				</ChoiceRow>
			</section>

			<section data-testid="audit-evaluation-decision">
				<StepHeading>Decision</StepHeading>
				<div className="mb-1.5 flex flex-col gap-1 text-xs text-gray-700" data-testid="audit-evaluation-models">
					{!said.length && "The evaluation has not run yet."}
					{said.map((row) => (
						<div key={row.id}>
							<b>
								{row.assessor_kind === "model" ? modelName(row.model) : "Check"}
								{row.assessor_kind === "model" && decides(row.model) ? " (decides)" : ""}: {answerWords(row)}.
							</b>
							{text(row.details.summary) && <> Reasoning: {text(row.details.summary)}</>}
						</div>
					))}
				</div>
				<BenchmarkToggle datasetId={review.datasetId} beforeAdd={storeLabel} active={active}>
					<div className="flex flex-col gap-1.5">
						<ChoiceRow label="Decision">
							<Form.Item name="decision" noStyle>
								<Radio.Group options={DECISIONS} optionType="button" buttonStyle="solid" size="small" aria-label="Decision" />
							</Form.Item>
						</ChoiceRow>
						{decision === "exclude" && (
							<Form.Item name="excludeReason" className="mb-0">
								<ExcludeReasons />
							</Form.Item>
						)}
						<Form.Item name="evaluationNote" className="mb-0">
							<Input size="small" maxLength={2000} aria-label="Note on the decision" placeholder="Note (optional)" />
						</Form.Item>
					</div>
				</BenchmarkToggle>
			</section>

		</div>
	);
}

/** The exclude reasons as a single choice; a Form.Item passes value and onChange. */
function ExcludeReasons({ value, onChange }: { value?: string | null; onChange?: (code: string) => void }) {
	return (
		<div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Why exclude">
			{EXCLUDE_REASONS.map((r) => (
				<Tag.CheckableTag key={r.code} checked={value === r.code} onChange={() => onChange?.(r.code)}>
					{r.label}
				</Tag.CheckableTag>
			))}
		</div>
	);
}
