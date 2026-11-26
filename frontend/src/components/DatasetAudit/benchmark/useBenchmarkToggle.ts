import { useState } from "react";
import { message } from "antd";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import { useBenchmarkMembership, useRemoveBenchmarkTargets } from "../../../hooks/useAuditBenchmarks";
import { BENCHMARKS, type BenchmarkKey } from "../../../utils/benchmarkLabels";

export interface IBenchmarkToggle {
	/** the target (a tile, or the dataset: null) is in the benchmark, as the server said after the last call */
	isMember: (tileId: number | null) => boolean;
	/** takes the target out, or puts it in by storing its label ticked in_benchmark (`addLabel`
	 * resolves false when nothing was stored) */
	toggle: (tileId: number | null, addLabel: () => Promise<boolean>) => Promise<void>;
	/** a call runs, or the membership is being read again: the toggle waits */
	pending: boolean;
}

/** Membership of a dataset or one of its tiles in a benchmark, for operators: a review of it ticked
 * in_benchmark. Adding stores the label with the tick; removing is audit.remove_benchmark_target.
 * The membership is read again after every call, and the toggle is off while a call runs.
 * Undefined for everyone else, so callers show nothing. */
export function useBenchmarkToggle(key: BenchmarkKey, datasetId: number): IBenchmarkToggle | undefined {
	const { canOperate } = useCanOperate();
	const membership = useBenchmarkMembership(canOperate ? datasetId : undefined);
	const remove = useRemoveBenchmarkTargets(key);
	const [running, setRunning] = useState(false);
	if (!canOperate) return undefined;
	const layer = BENCHMARKS.find((b) => b.key === key)!.layer;
	const isMember = (tileId: number | null) =>
		tileId === null ? !!membership.data?.dataset : !!membership.data?.tiles.some((t) => t.tile_id === tileId && t.layer === layer);
	const pending = running || membership.isFetching || membership.isLoading;
	const toggle = async (tileId: number | null, addLabel: () => Promise<boolean>) => {
		if (pending) return;
		const leaving = isMember(tileId);
		const what = tileId === null ? "dataset" : "crop";
		setRunning(true);
		try {
			if (leaving) await remove.mutateAsync([{ dataset_id: datasetId, tile_id: tileId }]);
			else if (!(await addLabel())) return;
			message.success(leaving ? `The ${what} left the benchmark` : `The ${what} is in the benchmark`);
		} catch (error) {
			message.error(`Not removed from the benchmark: ${(error as { message?: string }).message ?? "please try again"}`);
			// whatever happened, show what the server holds now
			await membership.refetch();
		} finally {
			setRunning(false);
		}
	};
	return { isMember, toggle, pending };
}
