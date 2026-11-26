import { useState } from "react";
import { Button, Modal, message } from "antd";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import { labelInput, useRemoveBenchmarkTargets, useSaveBenchmarkLabel } from "../../../hooks/useAuditBenchmarks";
import { BENCHMARKS, type BenchmarkKey, type IBenchmarkTarget } from "../../../utils/benchmarkLabels";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";

interface RemoveFromBenchmarkProps {
	benchmark: BenchmarkKey;
	/** the target on screen; null when there is none, while Undo stays */
	target: IBenchmarkTarget | null;
	/** the loaded targets on the target's dataset */
	datasetTargets: IBenchmarkTarget[];
	/** the targets that left, so the page can move on */
	onRemoved: (removed: IBenchmarkTarget[]) => void;
	/** off while another part of the page holds the keys */
	active: boolean;
}

/** "Remove (Del)" for operators: takes the current tile, or all tiles of its dataset, or the
 * dataset out of the benchmark after a confirm step (audit.remove_benchmark_target). The reviews
 * stay, without the tick; Undo stores the last removal's labels ticked again while the page is
 * open. Nothing for everyone else. */
export default function RemoveFromBenchmark({ benchmark, target, datasetTargets, onRemoved, active }: RemoveFromBenchmarkProps) {
	const { canOperate } = useCanOperate();
	const remove = useRemoveBenchmarkTargets(benchmark);
	const { save, isPending: restoring } = useSaveBenchmarkLabel(benchmark);
	const layer = BENCHMARKS.find((b) => b.key === benchmark)!.layer;
	const title = BENCHMARKS.find((b) => b.key === benchmark)!.title.toLowerCase();
	// the target the dialog asks about, fixed when it opens: the page behind it may move on
	const [pending, setPending] = useState<{ target: IBenchmarkTarget; datasetTargets: IBenchmarkTarget[] } | null>(null);
	const [undo, setUndo] = useState<IBenchmarkTarget[][]>([]);
	const ask = () => target && setPending({ target, datasetTargets });
	// Delete, or the Mac's delete key (Backspace); the crop review uses neither
	useAuditShortcuts({ Delete: ask, Backspace: ask }, canOperate && active && !!target && !pending);
	if (!canOperate) return null;

	const onTile = pending?.target.tile_id != null;
	const run = async (targets: IBenchmarkTarget[]) => {
		try {
			await remove.mutateAsync(targets.map(({ dataset_id, tile_id }) => ({ dataset_id, tile_id })));
			setPending(null);
			setUndo((u) => [...u, targets]);
			message.success(targets.length > 1 ? `${targets.length} crops left the benchmark` : `The ${onTile ? "crop" : "dataset"} left the benchmark`);
			onRemoved(targets);
		} catch (error) {
			message.error(`Not removed: ${(error as { message?: string }).message ?? "please try again"}`);
		}
	};
	const restore = async () => {
		const last = undo[undo.length - 1];
		if (!last) return;
		try {
			await Promise.all(
				last.map((t) => {
					const review = labelInput(t, layer);
					return review && save(t, review);
				}),
			);
			setUndo((u) => u.slice(0, -1));
			message.success(last.length > 1 ? `${last.length} crops are back in the benchmark` : "It is back in the benchmark");
		} catch (error) {
			message.error(`Not added back: ${(error as { message?: string }).message ?? "please try again"}`);
		}
	};
	const what = !pending ? "" : onTile ? `Crop ${pending.target.tile_id} of dataset ${pending.target.dataset_id}` : `Dataset ${pending.target.dataset_id}`;

	return (
		<>
			{target && (
				<Button size="small" danger onClick={ask} data-testid="benchmark-remove">
					Remove (Del)
				</Button>
			)}
			{undo.length > 0 && (
				<Button size="small" loading={restoring} onClick={() => void restore()} data-testid="benchmark-undo-remove">
					Undo remove
				</Button>
			)}
			<Modal
				open={!!pending}
				width={600}
				title="Remove from the benchmark?"
				onCancel={() => setPending(null)}
				footer={[
					<Button key="cancel" onClick={() => setPending(null)}>
						Cancel
					</Button>,
					onTile && pending && pending.datasetTargets.length > 1 && (
						<Button key="dataset" danger loading={remove.isPending} onClick={() => void run(pending.datasetTargets)} data-testid="benchmark-remove-dataset">
							Remove all {pending.datasetTargets.length} crops of dataset {pending.target.dataset_id}
						</Button>
					),
					<Button key="one" type="primary" danger autoFocus loading={remove.isPending} onClick={() => pending && void run([pending.target])} data-testid="benchmark-remove-confirm">
						Remove {onTile ? "crop" : "dataset"}
					</Button>,
				]}
			>
				<p className="m-0">
					{what} leaves the {title} benchmark. Its label stays as a review, and Undo brings it back while this page is open.
				</p>
			</Modal>
		</>
	);
}
