import { Form, Image, Input, Radio, Tag } from "antd";
import type { IAuditChecks, EvaluationDecision } from "../../../types/auditChecks";
import { EXCLUDE_REASONS, judgeName, judgementText } from "../../../utils/auditChecks";
import { evaluationReview, type IReviewDraft } from "../../../utils/auditReview";
import BenchmarkToggle from "../benchmark/BenchmarkToggle";
import ChoiceRow, { YES_NO } from "./ChoiceRow";
import CogFacts, { type CogFactsProps } from "./CogFacts";

interface EvaluationStepProps {
	datasetId: number;
	/** the dataset evaluation's current run and what each model said, when it has run */
	checks: IAuditChecks | undefined;
	cog: CogFactsProps;
	thumbnailUrl: string | null;
	/** B adds the dataset to the benchmark while the step is open */
	active: boolean;
}

const DECISIONS: { label: string; value: EvaluationDecision }[] = [
	{ label: "OK", value: "keep" },
	{ label: "Exclude", value: "exclude" },
];

/** A small heading inside a step. */
export const StepHeading = ({ children }: { children: string }) => (
	<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{children}</div>
);

/** Step 1: the map image (COG) and the thumbnail, each with its facts and an issue (yes or no),
 * then the dataset's decision: OK or Exclude. Both issues are output values, independent of the
 * decision; the form starts with the current values and Save stores what you change. Operators add the
 * dataset to the dataset evaluation benchmark here, labeled with the decision. */
export default function EvaluationStep({ datasetId, checks, cog, thumbnailUrl, active }: EvaluationStepProps) {
	const form = Form.useFormInstance<IReviewDraft>();
	const decision = Form.useWatch("decision", form);
	// each model's answer and reasoning; the one the check's call rests on (audit.evaluation_calls) first
	const deciding = checks?.evaluationJudgementId ?? null;
	const judgements = [...(checks?.datasetJudgements ?? [])].sort((a, b) => Number(b.id === deciding) - Number(a.id === deciding));
	/** The dataset's label in the benchmark: your decision as on the page. */
	const label = () => {
		const draft = form.getFieldsValue(true) as IReviewDraft;
		const answer = evaluationReview(draft, datasetId, draft.evaluationNote);
		return answer ? { review: answer.review, problem: answer.problems[0] } : { problem: "Pick OK or Exclude first: it is the dataset's label in the benchmark." };
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
					{!judgements.length && (checks?.checks.dataset_evaluation ? "No model answered on this run." : "The evaluation has not run yet.")}
					{judgements.map((j) => (
						<div key={j.id}>
							<b>
								{judgeName(j.judge)}
								{j.id === deciding ? " (decides)" : ""}: {judgementText(j)}.
							</b>
							{j.summary?.trim() && <> Reasoning: {j.summary.trim()}</>}
						</div>
					))}
				</div>
				<BenchmarkToggle datasetId={datasetId} label={label} active={active}>
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
