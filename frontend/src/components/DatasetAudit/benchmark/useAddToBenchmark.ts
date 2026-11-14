import { message } from "antd";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import { useAddBenchmarkTarget } from "../../../hooks/useAuditBenchmarks";
import type { AuditCheckKey } from "../../../types/auditChecks";

/** "+ Benchmark" (B) for operators: adds a crop of the dataset, or the whole dataset (null), to the
 * open benchmark of the check (audit.add_benchmark_target; adding it twice changes nothing). The
 * operator's answer on it is already its first label. Undefined for everyone else, so callers show
 * nothing. */
export function useAddToBenchmark(checkKey: AuditCheckKey, datasetId: number): ((cropId: number | null) => Promise<void>) | undefined {
	const { canOperate } = useCanOperate();
	const { mutateAsync } = useAddBenchmarkTarget();
	if (!canOperate) return undefined;
	return async (cropId) => {
		try {
			await mutateAsync({ checkKey, datasetId, cropId });
			message.success(cropId === null ? "The dataset is in the benchmark" : "The crop is in the benchmark");
		} catch (error) {
			message.error(`Not added to the benchmark: ${(error as { message?: string }).message ?? "please try again"}`);
		}
	};
}
