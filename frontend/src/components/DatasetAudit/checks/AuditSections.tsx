import type { ComponentProps, ReactNode } from "react";
import { Form } from "antd";
import type { IDataset } from "../../../types/dataset";
import type { IAcquisitionDateEstimate } from "../../../types/acquisitionDate";
import type { AuditCheckKey, IAuditChecks, IAuditDatasetResult, IAuditReviews, ReviewItem } from "../../../types/auditChecks";
import type { IGeorefCheck } from "../../../types/georefCheck";
import { AUDIT_SECTIONS, auditSection, type AuditSectionId, type IAuditSectionDef } from "../../../utils/auditChecks";
import { layerProgress, openReviewItems, reviewAnswers, sectionStatus, withDraft, type IReviewDraft } from "../../../utils/auditReview";
import { InlineLoadError } from "../../SectionStates";
import type AuditAOICard from "../AuditAOICard";
import AoiStep from "../steps/AoiStep";
import type { CogFactsProps } from "../steps/CogFacts";
import DateStep from "../steps/DateStep";
import EvaluationStep from "../steps/EvaluationStep";
import GeorefStep from "../steps/GeorefStep";
import PhenologyStep from "../steps/PhenologyStep";
import PredictionStep from "../steps/PredictionStep";
import AuditSection from "./AuditSection";
import ReviewChanges from "./ReviewChanges";
import ReviewRequiredLine from "./ReviewRequiredLine";
import { cropReviewOpen, type IAuditCheckView } from "./auditCheckView";
import { useAuditStepper } from "./useAuditStepper";

interface AuditSectionsProps {
	dataset: IDataset;
	checks: IAuditChecks | undefined;
	/** the check results failed to load: say so instead of "Not run yet" */
	checksFailed: boolean;
	onRetryChecks: () => void;
	/** people's answers as they count now, and the tile calls */
	reviews: IAuditReviews | undefined;
	/** the dataset's row of audit.dataset_outcomes */
	result: IAuditDatasetResult | null | undefined;
	resultFailed: boolean;
	hasAOI: boolean;
	/** each step's evidence besides the results */
	panels: {
		cog: CogFactsProps;
		thumbnailUrl: string | null;
		aoi: ComponentProps<typeof AuditAOICard>;
		georefCheck: IGeorefCheck | null | undefined;
		dateEstimate: IAcquisitionDateEstimate | null | undefined;
	};
	view: IAuditCheckView;
	setView: (patch: Partial<IAuditCheckView>) => void;
}

/** The Audit Review sidebar: what still needs a person, user reports and the seven steps in order.
 * Opening a step puts the map into that check's mode. The benchmark toggles sit in the steps their
 * check's benchmark labels: the dataset in the evaluation step, each crop in the crop review. */
export default function AuditSections({ dataset, checks, checksFailed, onRetryChecks, reviews, result, resultFailed, hasAOI, panels, view, setView }: AuditSectionsProps) {
	const form = Form.useFormInstance<IReviewDraft>();
	const draft = Form.useWatch((values: IReviewDraft) => values, { form, preserve: true }) ?? {};
	const evidenceOf = (s: IAuditSectionDef) => (s.checkKey ? checks?.checks[s.checkKey] : undefined);
	const openSection = view.section ? auditSection(view.section) : null;
	const cropReview = cropReviewOpen(view, openSection, openSection ? evidenceOf(openSection) : undefined);
	// Enter and Shift+Enter step through the review
	useAuditStepper({ view, setView, cropReview });

	// the line follows the page: answers in the draft and a drawn AOI settle their items before Save
	const answered: ReviewItem[] = [...reviewAnswers(draft, dataset.id, result).answered, ...(hasAOI ? (["aoi"] as const) : [])];
	const openItems = openReviewItems(result?.review_required, answered);
	// the step badges show your answers on the page, and an AOI drawn here, before Save
	const shown = result && withDraft({ ...result, aoi_exists: result.aoi_exists || hasAOI }, draft);
	const checksRun = Object.keys(checks?.checks ?? {}) as AuditCheckKey[];
	const toggle = (id: AuditSectionId) => setView({ section: view.section === id ? null : id, cropId: null, mapOnly: false });
	const predictionBody = (id: "forest" | "deadwood") => {
		const layer = id === "deadwood" ? "deadwood" : "forest_cover";
		const progress = layerProgress(reviews?.tileCalls ?? [], layer);
		const mapOnly = view.section === id && view.mapOnly && !!progress;
		return <PredictionStep layer={layer} result={result} progress={progress} onOpenCrops={mapOnly ? () => setView({ mapOnly: false }) : undefined} />;
	};

	const bodies: Record<AuditSectionId, ReactNode> = {
		evaluation: (
			<EvaluationStep
				datasetId={dataset.id}
				checks={checks}
				cog={panels.cog}
				thumbnailUrl={panels.thumbnailUrl}
				active={view.section === "evaluation"}
			/>
		),
		aoi: <AoiStep result={result} editor={panels.aoi} />,
		georef: <GeorefStep check={panels.georefCheck} result={result} />,
		date: <DateStep dataset={dataset} result={result} estimate={panels.dateEstimate} />,
		phenology: <PhenologyStep dataset={dataset} result={result} />,
		forest: predictionBody("forest"),
		deadwood: predictionBody("deadwood"),
	};

	return (
		<>
			<ReviewRequiredLine items={openItems} unknown={resultFailed || result === null} />
			<ReviewChanges reviews={reviews} result={result} />
			{(checksFailed || resultFailed) && (
				<div className="mb-2">
					<InlineLoadError message="The automated check results couldn’t load." onRetry={onRetryChecks} />
				</div>
			)}
			{checks && !checks.available && (
				<div className="mb-2 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">The automated check results can’t be read on this server yet.</div>
			)}
			{AUDIT_SECTIONS.map((s, i) => (
				<AuditSection
					key={s.id}
					number={i + 1}
					title={s.title}
					status={sectionStatus(s.id, shown, openItems, checksRun)}
					open={view.section === s.id}
					onToggle={() => toggle(s.id)}
				>
					{bodies[s.id]}
				</AuditSection>
			))}
			<div className="mt-2 px-2 text-[11px] text-gray-400" data-testid="audit-shortcuts">
				Keys: Enter next step · Shift+Enter back · B benchmark (step 1) · Ctrl+S save · the crop review lists its own
			</div>
		</>
	);
}
