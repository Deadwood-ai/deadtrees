import { useEffect, useMemo, useState } from "react";
import { Button, Form, Radio, Segmented, Tag, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import { LAYER_LABELS, myAnswer, stepCrop, verdictLabel, type IAuditSectionDef } from "../../../utils/auditChecks";
import { cropCalls, cropFindings, cropsForReview, layerRatingFromCrops, type ICropFinding } from "../../../utils/cropCalls";
import { useAuditShortcuts } from "./useAuditShortcuts";

interface CropAnswersProps {
	datasetId: number;
	/** the section whose check judged the crops: its layers and verdicts are what a reviewer answers */
	section: IAuditSectionDef;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
	disabled: boolean;
	/** the section is open: only then do the keys step and answer */
	active: boolean;
}

/** Per-crop verdicts on each layer the check judged: one person row per crop and layer.
 * n / p step through the crops, space marks every layer fine and 1 to 3 give every layer that
 * verdict, both moving on. */
export default function CropAnswers({ datasetId, section, evidence, people, cropId, onSelectCrop, disabled, active }: CropAnswersProps) {
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswers();
	const checkKey = section.checkKey!;
	// the order the map numbers them: the crops the check counted major first
	const calls = useMemo(() => cropCalls(evidence, section.layers), [evidence, section.layers]);
	const crops = cropsForReview(evidence, calls);
	const flagged = crops.filter((c) => calls.get(c.id) === "major");
	// by default n / p go through the crops the check flagged only; A switches to all crops
	const [allCrops, setAllCrops] = useState(false);
	const cycle = allCrops || !flagged.length ? crops : flagged;
	const index = crops.findIndex((c) => c.id === cropId);

	// the layer's saved rating follows from the crops: your answers, else the check's calls
	const form = Form.useFormInstance();
	const field = section.fields[0];
	const rating = layerRatingFromCrops(evidence, calls, (id) => myAnswer(people, user?.id, evidence.run.id, { checkKey, layer: section.layers[0], cropId: id })?.verdict ?? null);
	useEffect(() => {
		if (rating && field && form.getFieldValue(field) !== rating.quality) form.setFieldsValue({ [field]: rating.quality });
	}, [rating?.quality, field, form]); // eslint-disable-line react-hooks/exhaustive-deps
	const runId = evidence.run.id;
	const target = (layer: AuditLayer) => ({ checkKey, layer, cropId });
	const modelRows = (layer: AuditLayer) => evidence.automated.filter((a) => a.crop_id === cropId && a.layer === layer);

	/** Stores one verdict for the layers of the selected crop; false when nothing was saved. */
	const answer = async (layers: AuditLayer[], verdict: AuditVerdict): Promise<boolean> => {
		if (cropId === null || isPending) return false;
		try {
			await save(
				layers.map((layer) => ({
					check_key: checkKey,
					dataset_id: datasetId,
					run_id: runId,
					crop_id: cropId,
					layer,
					label_id: modelRows(layer)[0]?.label_id ?? null,
					verdict,
				})),
			);
			return true;
		} catch {
			message.error("Your crop answer was not saved. Please try again.");
			return false;
		}
	};

	const step = (by: 1 | -1) => {
		const next = stepCrop(cycle, cropId, by);
		if (next !== null) onSelectCrop(next);
	};

	// n / p step; space marks every layer fine and 1 to 3 give every layer that verdict, both moving on
	const answerAndStep = (verdict: AuditVerdict | undefined) => {
		if (cropId === null || disabled || !verdict) return;
		void answer(section.layers, verdict).then((saved) => saved && step(1));
	};
	useAuditShortcuts(
		{
			n: () => step(1),
			p: () => step(-1),
			a: () => setAllCrops((all) => !all),
			" ": () => answerAndStep("ok"),
			"1": () => answerAndStep(section.verdicts[0]),
			"2": () => answerAndStep(section.verdicts[1]),
			"3": () => answerAndStep(section.verdicts[2]),
		},
		active,
	);

	if (!crops.length) return <div className="text-xs text-gray-500">This check stored no crops.</div>;
	const ratingLine = rating && (
		<div className="text-xs" data-testid="audit-layer-rating">
			Layer rating from the crops: <b>{QUALITY_WORDS[rating.quality]}</b>
			<span className="text-gray-500">
				{" "}
				· {rating.major} major of {rating.counted} counted crops (your answers, else the check's) · goes into the audit
			</span>
		</div>
	);
	const flaggedLine = flagged.length > 0 && (
		<div className="flex flex-wrap items-center gap-1 text-xs">
			<span className="text-gray-600">Counted major by the check:</span>
			{flagged.map((c) => (
				<Button key={c.id} size="small" danger type={c.id === cropId ? "primary" : "default"} onClick={() => onSelectCrop(c.id)}>
					Crop {crops.findIndex((o) => o.id === c.id) + 1}
				</Button>
			))}
		</div>
	);
	const cycleSwitch =
		flagged.length > 0 ? (
			<Segmented
				size="small"
				value={allCrops ? "all" : "flagged"}
				onChange={(v) => setAllCrops(v === "all")}
				options={[
					{ label: `Flagged (${flagged.length})`, value: "flagged" },
					{ label: `All (${crops.length})`, value: "all" },
				]}
			/>
		) : null;
	if (cropId === null || index < 0) {
		return (
			<div className="flex flex-col gap-2">
				{ratingLine}
				{flaggedLine}
				<Button block type="primary" ghost onClick={() => step(1)}>
					{flagged.length ? `Start with the ${flagged.length} flagged crops (n)` : `Start with crop 1 of ${crops.length} (n)`}
				</Button>
			</div>
		);
	}
	const call = calls.get(cropId) ?? null;

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-white p-2.5" data-testid="audit-crop">
			{ratingLine}
			{flaggedLine}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="flex items-center gap-1.5 text-xs font-semibold">
					Crop {index + 1} of {crops.length}
					{call && <CallTag call={call} />}
				</span>
				{cycleSwitch}
			</div>
			{section.layers.map((layer) => {
				const mine = myAnswer(people, user?.id, runId, target(layer));
				const findings = cropFindings(evidence, cropId, layer);
				return (
					<div key={layer} className="flex flex-col gap-1.5">
						<CropFindings findings={findings} label={verdictLabel.bind(null, checkKey)} />
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="text-xs font-medium">This crop:</span>
							<Radio.Group
								size="small"
								optionType="button"
								buttonStyle="solid"
								value={mine?.verdict}
								disabled={disabled || isPending}
								aria-label={`${LAYER_LABELS[layer]} on this crop`}
								onChange={(e) => void answer([layer], e.target.value as AuditVerdict)}
								options={section.verdicts.map((v, i) => ({ value: v, label: `${i + 1} ${verdictLabel(checkKey, v)}` }))}
							/>
						</div>
					</div>
				);
			})}
			<div className="text-[11px] text-gray-500">
				n / p next or previous {allCrops || !flagged.length ? "crop" : "flagged crop"} · A all or flagged · T raw or prediction · 1 to 3 answer and go on · space = fine and go on
			</div>
		</div>
	);
}

/** What each model saw in the crop: its call, the error types it found with their share of the
 * crop, and its own words. */
function CropFindings({ findings, label }: { findings: ICropFinding[]; label: (verdict: AuditVerdict) => string }) {
	if (!findings.length) return <div className="text-[11px] text-gray-500">No model judged this crop.</div>;
	return (
		<div className="flex flex-col gap-1.5" data-testid="audit-crop-findings">
			<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">What the models saw</div>
			{findings.map((f) => (
				<div key={f.model} className="text-xs">
					<div>
						<span className="font-medium">{f.model}:</span> <VerdictTag verdict={f.verdict} text={label(f.verdict)} />
					</div>
					{f.issues.length > 0 && (
						<div className="mt-0.5 flex flex-wrap gap-1">
							{f.issues.map((i) => (
								<Tag key={i.label} className="m-0 text-[11px]" color={f.verdict === "major" ? "orange" : "default"}>
									{i.label}
									{i.areaPct !== null ? ` · ${i.areaPct < 1 ? "<1" : Math.round(i.areaPct)}% of crop` : ""}
								</Tag>
							))}
						</div>
					)}
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

const QUALITY_WORDS = { great: "Great", sentinel_ok: "OK", bad: "Bad" } as const;

const VERDICT_COLOR: Record<AuditVerdict, string> = { ok: "green", minor: "gold", major: "red", unsure: "default" };

/** A verdict as a coloured tag with its word, so minor and major read apart at a glance. */
function VerdictTag({ verdict, text }: { verdict: AuditVerdict; text: string }) {
	return (
		<Tag className="m-0 text-[11px]" color={VERDICT_COLOR[verdict]}>
			{text}
		</Tag>
	);
}

/** The check's own call on the crop (its rule on the models' scores): major, or fine. */
function CallTag({ call }: { call: AuditVerdict }) {
	return (
		<Tag className="m-0 text-[11px] font-normal" color={call === "major" ? "red" : "green"}>
			check: {call === "major" ? "major errors" : "fine"}
		</Tag>
	);
}
