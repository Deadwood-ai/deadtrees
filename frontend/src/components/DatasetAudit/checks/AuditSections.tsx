import type { ComponentProps, ReactNode } from "react";
import { Form } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import type { AuditFormValues } from "../../../hooks/useDatasetAudit";
import type { IAuditChecks } from "../../../types/auditChecks";
import {
	AUDIT_SECTIONS,
	LAYER_LABELS,
	auditSection,
	automatedVerdict,
	legacySectionStatus,
	myAnswer,
	sectionStatus,
	type AuditSectionId,
	type IAuditSectionDef,
	type IAuditSectionStatus,
} from "../../../utils/auditChecks";
import { AcquisitionDateCard } from "../AcquisitionDateCard";
import AuditAOICard from "../AuditAOICard";
import { COGQualityCard, OrthoFilePanel, PhenologyCard, PredictionQualityCard, ThumbnailCard } from "../AuditStepCards";
import { GeoreferencingCard } from "../GeoreferencingCard";
import { InlineLoadError } from "../../SectionStates";
import AuditSection from "./AuditSection";
import CheckAnswer from "./CheckAnswer";
import CheckSummary from "./CheckSummary";
import CropAnswers from "./CropAnswers";
import DerivedDecision from "./DerivedDecision";
import type { IAuditCheckView } from "./auditCheckView";

interface AuditSectionsProps {
	datasetId: number;
	checks: IAuditChecks | undefined;
	/** the check results failed to load: say so instead of showing "Not run yet" */
	checksFailed: boolean;
	onRetryChecks: () => void;
	/** the existing evidence panels, each section's body */
	panels: {
		georef: ComponentProps<typeof GeoreferencingCard>;
		date: ComponentProps<typeof AcquisitionDateCard>;
		phenology: ComponentProps<typeof PhenologyCard>;
		aoi: ComponentProps<typeof AuditAOICard>;
		file: ComponentProps<typeof OrthoFilePanel>;
		thumbnailUrl: string | null;
	};
	hasAOI: boolean;
	/** user reports, shown under the decision and above the sections */
	userReports: ReactNode;
	view: IAuditCheckView;
	setView: (patch: Partial<IAuditCheckView>) => void;
	/** no audit lease on this page */
	disabled: boolean;
}

/** The audit sidebar: the derived decision, user reports and the six checks in order.
 * Opening a section puts the map into that check's mode. */
export default function AuditSections({ datasetId, checks, checksFailed, onRetryChecks, panels, hasAOI, userReports, view, setView, disabled }: AuditSectionsProps) {
	const { user } = useAuth();
	const form = Form.useFormInstance<AuditFormValues>();
	const phenology = Form.useWatch("has_valid_phenology", { form, preserve: true });
	const people = checks?.people ?? [];
	const evidenceOf = (s: IAuditSectionDef) => (s.checkKey ? checks?.checks[s.checkKey] : undefined);
	const answeredAll = (s: IAuditSectionDef) => {
		const evidence = evidenceOf(s);
		return !!evidence && s.layers.every((layer) => myAnswer(people, user?.id, evidence.run.id, { checkKey: s.checkKey!, layer }));
	};

	// a section whose check has run reads the audit tables; the others fall back to the saved audit and older tables
	const status = (s: IAuditSectionDef): IAuditSectionStatus => {
		const evidence = evidenceOf(s);
		if (evidence) return sectionStatus(s, evidence, answeredAll(s));
		return legacySectionStatus(s.id, {
			hasAOI,
			phenology,
			georefCheck: panels.georef.check,
			dateEstimate: panels.date.estimate,
			reviewItems: panels.georef.reviewItems,
		});
	};

	const statuses = Object.fromEntries(AUDIT_SECTIONS.map((s) => [s.id, status(s)])) as Record<AuditSectionId, IAuditSectionStatus>;
	const evaluation = checks?.checks.dataset_evaluation;
	const myEvaluation = evaluation ? myAnswer(people, user?.id, evaluation.run.id, { checkKey: "dataset_evaluation", layer: "image" }) : null;
	const open = (id: AuditSectionId) => setView({ section: view.section === id ? null : id, cropId: null });

	const answers = (s: IAuditSectionDef) => {
		const evidence = evidenceOf(s);
		if (!evidence) return null;
		return (
			<div className="mb-3 flex flex-col gap-3">
				<CheckSummary section={s} evidence={evidence} />
				{s.layers.map((layer) => (
					<div key={layer}>
						{s.layers.length > 1 && <div className="mb-1 text-xs font-medium">{LAYER_LABELS[layer]}</div>}
						<CheckAnswer
							datasetId={datasetId}
							section={s}
							layer={layer}
							evidence={evidence}
							people={people}
							disabled={disabled}
						/>
					</div>
				))}
				{s.cropAnswers && (
					<CropAnswers
						datasetId={datasetId}
						section={s}
						evidence={evidence}
						people={people}
						cropId={view.section === s.id ? view.cropId : null}
						onSelectCrop={(cropId) => setView({ cropId })}
						disabled={disabled}
						active={view.section === s.id}
					/>
				)}
			</div>
		);
	};
	// where a check has run, the reviewer's answer decides its saved-audit field
	const answerOwned = (id: AuditSectionId) => !!evidenceOf(auditSection(id));

	const bodies: Record<AuditSectionId, ReactNode> = {
		evaluation: (
			<>
				{answers(auditSection("evaluation"))}
				<COGQualityCard />
				<ThumbnailCard thumbnailUrl={panels.thumbnailUrl} />
				<OrthoFilePanel {...panels.file} />
			</>
		),
		aoi: (
			<>
				<div className="mb-2 text-xs text-gray-600">Edit the area of interest on the map. The later checks run inside it.</div>
				<AuditAOICard {...panels.aoi} />
			</>
		),
		georef: (
			<>
				{answers(auditSection("georef"))}
				<GeoreferencingCard {...panels.georef} answerOwned={answerOwned("georef")} />
			</>
		),
		date: (
			<>
				{answers(auditSection("date"))}
				<AcquisitionDateCard {...panels.date} answerOwned={answerOwned("date")} />
			</>
		),
		phenology: <PhenologyCard {...panels.phenology} />,
		prediction: (
			<>
				{answers(auditSection("prediction"))}
				<div className="mb-1 text-xs font-medium">Saved audit ratings</div>
				<PredictionQualityCard answerOwned={answerOwned("prediction")} />
			</>
		),
	};

	return (
		<>
			<DerivedDecision
				evaluation={myEvaluation?.verdict ?? automatedVerdict(evaluation, "image")}
				needsYou={Object.values(statuses).filter((s) => s.needsYou).length}
			/>
			{userReports}
			{checksFailed && (
				<div className="mb-2">
					<InlineLoadError message="The automated check results couldn’t load." onRetry={onRetryChecks} />
				</div>
			)}
			{checks && !checks.available && (
				<div className="mb-2 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">
					The automated check results can’t be read here yet. Answer with the saved audit fields in each section.
				</div>
			)}
			{AUDIT_SECTIONS.map((s, i) => (
				<AuditSection key={s.id} number={i + 1} title={s.title} status={statuses[s.id]} open={view.section === s.id} onToggle={() => open(s.id)}>
					{bodies[s.id]}
				</AuditSection>
			))}
		</>
	);
}
