import type { ComponentProps, ReactNode } from "react";
import { Form } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import type { AuditFormValues } from "../../../hooks/useDatasetAudit";
import type { IAuditChecks } from "../../../types/auditChecks";
import {
	AUDIT_SECTIONS,
	auditSection,
	automatedVerdict,
	myAnswer,
	sectionStatus,
	type AuditSectionId,
	type IAuditSectionDef,
	type IAuditSectionStatus,
} from "../../../utils/auditChecks";
import { summarizeGeorefCheck } from "../../../utils/georefCheck";
import { AcquisitionDateCard } from "../AcquisitionDateCard";
import AuditAOICard from "../AuditAOICard";
import { COGQualityCard, OrthoFilePanel, PhenologyCard, PredictionQualityCard, ThumbnailCard } from "../AuditStepCards";
import { GeoreferencingCard } from "../GeoreferencingCard";
import AuditSection from "./AuditSection";
import CheckAnswer from "./CheckAnswer";
import CheckSummary from "./CheckSummary";
import CropAnswers from "./CropAnswers";
import DerivedDecision from "./DerivedDecision";
import type { IAuditCheckView } from "./auditCheckView";

interface AuditSectionsProps {
	datasetId: number;
	checks: IAuditChecks | undefined;
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

const TONES = { success: "ok", error: "bad", warning: "warn" } as const;

/** The audit sidebar: the derived decision, user reports and the six checks in order.
 * Opening a section puts the map into that check's mode. */
export default function AuditSections({ datasetId, checks, panels, hasAOI, userReports, view, setView, disabled }: AuditSectionsProps) {
	const { user } = useAuth();
	const form = Form.useFormInstance<AuditFormValues>();
	const phenology = Form.useWatch("has_valid_phenology", { form, preserve: true });
	const people = checks?.people ?? [];
	const evidenceOf = (s: IAuditSectionDef) => (s.checkKey ? checks?.checks[s.checkKey] : undefined);
	const answeredAll = (s: IAuditSectionDef) => {
		const evidence = evidenceOf(s);
		return !!evidence && s.layers.every((layer) => myAnswer(people, user?.id, evidence.run.id, { checkKey: s.checkKey!, layer }));
	};

	const status = (s: IAuditSectionDef): IAuditSectionStatus => {
		if (evidenceOf(s)) return sectionStatus(s, evidenceOf(s), answeredAll(s));
		const reviewItem = (item: string) => panels.georef.reviewItems.some((i) => i.item === item);
		switch (s.id) {
			case "aoi":
				return hasAOI ? { label: "Set", tone: "ok", needsYou: false } : { label: "Missing", tone: "warn", needsYou: false };
			case "phenology":
				return phenology === undefined || phenology === null
					? { label: "Manual", tone: "todo", needsYou: false }
					: { label: phenology ? "In season" : "Out of season", tone: phenology ? "ok" : "warn", needsYou: false };
			case "georef": {
				const check = panels.georef.check;
				if (!check) break;
				if (reviewItem("is_georeferenced")) return { label: "Needs you", tone: "warn", needsYou: true };
				const summary = summarizeGeorefCheck(check);
				return { label: summary.verdict.split(",")[0], tone: TONES[summary.tone], needsYou: false };
			}
			case "date": {
				const estimate = panels.date.estimate;
				if (!estimate) break;
				if (reviewItem("acquisition_date")) return { label: "Needs you", tone: "warn", needsYou: true };
				return estimate.is_mismatch ? { label: "Mismatch", tone: "bad", needsYou: false } : { label: "Valid", tone: "ok", needsYou: false };
			}
		}
		return { label: "Not run yet", tone: "todo", needsYou: false };
	};

	const statuses = Object.fromEntries(AUDIT_SECTIONS.map((s) => [s.id, status(s)])) as Record<AuditSectionId, IAuditSectionStatus>;
	const evaluation = checks?.checks.dataset_evaluation;
	const myEvaluation = evaluation ? myAnswer(people, user?.id, evaluation.run.id, { checkKey: "dataset_evaluation", layer: "image" }) : null;
	const open = (id: AuditSectionId) =>
		setView({ section: view.section === id ? null : id, ...(view.section !== id ? { cropId: null, provider: undefined } : {}) });

	const answers = (s: IAuditSectionDef) => {
		const evidence = evidenceOf(s);
		if (!evidence) return null;
		return (
			<div className="mb-3 flex flex-col gap-3">
				<CheckSummary section={s} evidence={evidence} />
				{s.layers.map((layer) => (
					<div key={layer}>
						{s.layers.length > 1 && <div className="mb-1 text-xs font-medium capitalize">{layer.replace("_", " ")}</div>}
						<CheckAnswer
							datasetId={datasetId}
							section={s}
							layer={layer}
							evidence={evidence}
							people={people}
							choices={s.id === "prediction" ? ["ok", "minor", "major"] : undefined}
							disabled={disabled}
						/>
					</div>
				))}
			</div>
		);
	};

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
				<GeoreferencingCard {...panels.georef} />
			</>
		),
		date: (
			<>
				{answers(auditSection("date"))}
				<AcquisitionDateCard {...panels.date} />
			</>
		),
		phenology: <PhenologyCard {...panels.phenology} />,
		prediction: (
			<>
				{answers(auditSection("prediction"))}
				{checks?.checks.prediction_quality && (
					<div className="mb-3">
						<CropAnswers
							datasetId={datasetId}
							evidence={checks.checks.prediction_quality}
							people={people}
							cropId={view.section === "prediction" ? view.cropId : null}
							onSelectCrop={(cropId) => setView({ cropId })}
							disabled={disabled}
							active={view.section === "prediction"}
						/>
					</div>
				)}
				<div className="mb-1 text-xs font-medium">Saved audit ratings</div>
				<PredictionQualityCard />
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
