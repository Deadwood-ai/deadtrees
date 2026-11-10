import { useEffect, useRef } from "react";
import { message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import { LAYER_LABELS, myAnswer, orderedCrops, stepCrop, verdictLabel, type IAuditSectionDef } from "../../../utils/auditChecks";

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

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Per-crop verdicts on each layer the check judged: one person row per crop and layer.
 * n / p step through the crops, space marks every layer fine and moves on. */
export default function CropAnswers({ datasetId, section, evidence, people, cropId, onSelectCrop, disabled, active }: CropAnswersProps) {
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswers();
	const checkKey = section.checkKey!;
	const crops = orderedCrops(evidence);
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

	const keys = useRef({ step, answer, disabled, cropId, layers: section.layers });
	keys.current = { step, answer, disabled, cropId, layers: section.layers };
	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent) => {
			if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
			const k = keys.current;
			if (event.key === "n") k.step(1);
			else if (event.key === "p") k.step(-1);
			else if (event.key === " " && k.cropId !== null && !k.disabled) {
				event.preventDefault();
				void k.answer(k.layers, "ok").then((saved) => saved && k.step(1));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);

	if (!crops.length) return <div className="text-xs text-gray-500">This check stored no crops.</div>;
	if (cropId === null || index < 0) {
		return (
			<button type="button" className="cursor-pointer rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-xs" onClick={() => step(1)}>
				Start with crop 1 of {crops.length} (or click a square on the map)
			</button>
		);
	}

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-white p-2.5">
			<div className="text-xs font-semibold">
				Crop {index + 1} of {crops.length} · n / p to step, space = all fine
			</div>
			{section.layers.map((layer) => {
				const mine = myAnswer(people, user?.id, runId, target(layer));
				return (
					<div key={layer} className="flex flex-col gap-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="w-20 text-xs">{LAYER_LABELS[layer]}</span>
							{section.verdicts.map((v, i) => (
								<button
									key={v}
									type="button"
									disabled={disabled || isPending}
									onClick={() => answer([layer], v)}
									className={`min-h-[32px] cursor-pointer rounded-md border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${mine?.verdict === v ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 bg-white"}`}
								>
									{i + 1} {verdictLabel(checkKey, v)}
								</button>
							))}
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
