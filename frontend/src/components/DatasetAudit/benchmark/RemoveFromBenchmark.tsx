import { useState } from "react";
import { Button, Modal, message } from "antd";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import { useAddBenchmarkTarget, useRemoveBenchmarkTarget } from "../../../hooks/useAuditBenchmarks";
import type { AuditCheckKey, IBenchmarkTarget } from "../../../types/auditChecks";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";

type Removed = { dataset_id: number; crop_id: number | null };

interface RemoveFromBenchmarkProps {
	checkKey: AuditCheckKey;
	benchmark: { id: number; name: string; version: string };
	target: IBenchmarkTarget;
	/** how many targets of the loaded benchmark sit on the target's dataset */
	datasetTargets: number;
	/** the targets that left, so the page can move on */
	onRemoved: (removed: Removed[]) => void;
	/** off while another part of the page holds the keys */
	active: boolean;
}

/** "Remove (Del)" for operators: takes the current crop, or its whole dataset, out of the open
 * benchmark after a confirm step (audit.remove_benchmark_target). The labels stay; Undo adds the
 * last removal back while the page is open. Nothing for everyone else. */
export default function RemoveFromBenchmark({ checkKey, benchmark, target, datasetTargets, onRemoved, active }: RemoveFromBenchmarkProps) {
	const { canOperate } = useCanOperate();
	const remove = useRemoveBenchmarkTarget(benchmark.id);
	const add = useAddBenchmarkTarget();
	const [confirming, setConfirming] = useState(false);
	const [undo, setUndo] = useState<Removed[][]>([]);
	const onCrop = target.crop_id !== null;
	// Delete, or the Mac's delete key (Backspace); the crop review uses neither
	useAuditShortcuts({ Delete: () => setConfirming(true), Backspace: () => setConfirming(true) }, canOperate && active && !confirming);
	if (!canOperate) return null;

	const run = async (cropId: number | null) => {
		try {
			const removed = await remove.mutateAsync({ checkKey, datasetId: target.dataset_id, cropId });
			setConfirming(false);
			if (!removed.length) return;
			setUndo((u) => [...u, removed]);
			message.success(removed.length > 1 ? `${removed.length} crops left the benchmark` : `The ${onCrop ? "crop" : "dataset"} left the benchmark`);
			onRemoved(removed);
		} catch (error) {
			message.error(`Not removed: ${(error as { message?: string }).message ?? "please try again"}`);
		}
	};
	const restore = async () => {
		const last = undo[undo.length - 1];
		if (!last) return;
		try {
			for (const row of last) await add.mutateAsync({ checkKey, datasetId: row.dataset_id, cropId: row.crop_id });
			setUndo((u) => u.slice(0, -1));
			message.success(last.length > 1 ? `${last.length} crops are back in the benchmark` : "It is back in the benchmark");
		} catch (error) {
			message.error(`Not added back: ${(error as { message?: string }).message ?? "please try again"}`);
		}
	};

	const what = onCrop ? `Crop ${target.crop_id} of dataset ${target.dataset_id}` : `Dataset ${target.dataset_id}`;
	return (
		<>
			<Button size="small" danger onClick={() => setConfirming(true)} data-testid="benchmark-remove">
				Remove (Del)
			</Button>
			{undo.length > 0 && (
				<Button size="small" loading={add.isPending} onClick={() => void restore()} data-testid="benchmark-undo-remove">
					Undo remove
				</Button>
			)}
			<Modal
				open={confirming}
				width={600}
				title="Remove from the benchmark?"
				onCancel={() => setConfirming(false)}
				footer={[
					<Button key="cancel" onClick={() => setConfirming(false)}>
						Cancel
					</Button>,
					onCrop && datasetTargets > 1 && (
						<Button key="dataset" danger loading={remove.isPending} onClick={() => void run(null)} data-testid="benchmark-remove-dataset">
							Remove all {datasetTargets} crops of dataset {target.dataset_id}
						</Button>
					),
					<Button key="one" type="primary" danger autoFocus loading={remove.isPending} onClick={() => void run(target.crop_id)} data-testid="benchmark-remove-confirm">
						Remove {onCrop ? "crop" : "dataset"}
					</Button>,
				]}
			>
				<p className="m-0">
					{what} leaves {benchmark.name} {benchmark.version}. Its labels stay, and Undo brings it back while this page is open.
				</p>
			</Modal>
		</>
	);
}
