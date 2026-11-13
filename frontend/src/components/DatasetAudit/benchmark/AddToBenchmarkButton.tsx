import { Button, message } from "antd";
import { useCanOperate } from "../../../hooks/useUserPrivileges";
import { useAddBenchmarkTarget, useBenchmarkMembership } from "../../../hooks/useAuditBenchmarks";
import type { AuditCheckKey } from "../../../types/auditChecks";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";

interface AddToBenchmarkButtonProps {
	checkKey: AuditCheckKey;
	datasetId: number;
	/** the crop to add; null adds the whole dataset */
	cropId?: number | null;
	/** only while active does B add it */
	active: boolean;
}

/** "+ Benchmark" (key B), operators only: adds the crop or the dataset to the open benchmark of
 * the check (audit.add_benchmark_target). Your answer on it is already its first label. */
export default function AddToBenchmarkButton({ checkKey, datasetId, cropId = null, active }: AddToBenchmarkButtonProps) {
	const { canOperate } = useCanOperate();
	const { data: members } = useBenchmarkMembership(canOperate ? datasetId : undefined);
	const { mutateAsync, isPending } = useAddBenchmarkTarget();
	const added = !!members?.some((m) => m.benchmark.check_key === checkKey && m.crop_id === cropId);
	const add = async () => {
		if (added || isPending) return;
		try {
			await mutateAsync({ checkKey, datasetId, cropId });
			message.success(cropId === null ? "Dataset added to the benchmark" : "Crop added to the benchmark");
		} catch (error) {
			message.error(`Not added: ${(error as { message?: string }).message ?? "please try again"}`);
		}
	};
	useAuditShortcuts({ b: () => void add(), B: () => void add() }, active && canOperate);
	if (!canOperate) return null;
	return (
		<div>
			<Button size="small" disabled={added} loading={isPending} onClick={() => void add()} data-testid="add-to-benchmark">
			{added ? "In benchmark ✓" : <>+ Benchmark <kbd className="ml-1">B</kbd></>}
			</Button>
		</div>
	);
}
