import { useState } from "react";
import { Button } from "antd";
import { useBenchmarkMembership } from "../../../hooks/useAuditBenchmarks";
import type { AuditCheckKey } from "../../../types/auditChecks";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";
import { useAddToBenchmark } from "./useAddToBenchmark";

interface AddToBenchmarkButtonProps {
	checkKey: AuditCheckKey;
	datasetId: number;
	/** only while active does B add the dataset */
	active: boolean;
}

/** "+ Benchmark" (key B) on audit step 1, operators only: the whole dataset goes into the dataset
 * evaluation benchmark. The crop review has its own (CropReviewer onAddToBenchmark). */
export default function AddToBenchmarkButton({ checkKey, datasetId, active }: AddToBenchmarkButtonProps) {
	const add = useAddToBenchmark(checkKey, datasetId);
	const { data: members } = useBenchmarkMembership(add ? datasetId : undefined);
	const [adding, setAdding] = useState(false);
	const added = !!members?.some((m) => m.benchmark.check_key === checkKey && m.crop_id === null);
	const run = async () => {
		if (!add || added || adding) return;
		setAdding(true);
		await add(null).finally(() => setAdding(false));
	};
	useAuditShortcuts({ b: () => void run() }, active && !!add);
	if (!add) return null;
	return (
		<div>
			<Button size="small" disabled={added} loading={adding} onClick={() => void run()} data-testid="add-to-benchmark">
				{added ? "In benchmark ✓" : <>+ Benchmark <kbd className="ml-1">B</kbd></>}
			</Button>
		</div>
	);
}
