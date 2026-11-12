import { useMemo } from "react";
import { Button, Radio, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import { LAYER_LABELS, myAnswer, stepCrop, verdictLabel, type IAuditSectionDef } from "../../../utils/auditChecks";
import { cropCalls, cropsForReview } from "../../../utils/cropCalls";
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
	const index = crops.findIndex((c) => c.id === cropId);
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
		const next = stepCrop(crops, cropId, by);
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
			" ": () => answerAndStep("ok"),
			"1": () => answerAndStep(section.verdicts[0]),
			"2": () => answerAndStep(section.verdicts[1]),
			"3": () => answerAndStep(section.verdicts[2]),
		},
		active,
	);

	if (!crops.length) return <div className="text-xs text-gray-500">This check stored no crops.</div>;
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
	if (cropId === null || index < 0) {
		return (
			<div className="flex flex-col gap-2">
				{flaggedLine}
				<Button block onClick={() => step(1)}>
					Start with crop 1 of {crops.length} (or click a square on the map)
				</Button>
			</div>
		);
	}
	const call = calls.get(cropId) ?? null;

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-white p-2.5">
			{flaggedLine}
			<div className="text-xs font-semibold">
				Crop {index + 1} of {crops.length}
				{call && <span className={call === "major" ? "text-red-600" : "text-gray-500"}> · the check: {call === "major" ? "major errors" : "fine"}</span>}
				<span className="font-normal text-gray-500"> · n / p to step, 1 to 3 = that verdict on both layers, space = all fine</span>
			</div>
			{section.layers.map((layer) => {
				const mine = myAnswer(people, user?.id, runId, target(layer));
				return (
					<div key={layer} className="flex flex-col gap-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="w-20 text-xs">{LAYER_LABELS[layer]}</span>
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
						{mine && (
							<div className="pl-20 text-[11px] text-gray-500">
								Models: {modelRows(layer).map((r) => `${r.model} ${verdictLabel(checkKey, r.verdict)}`).join(" · ") || "none"}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
