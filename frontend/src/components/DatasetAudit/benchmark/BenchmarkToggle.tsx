import type { ReactNode } from "react";
import type { BenchmarkRef } from "../../../types/auditChecks";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";
import BenchmarkPanel from "./BenchmarkPanel";
import { useBenchmarkToggle } from "./useBenchmarkToggle";

interface BenchmarkToggleProps {
	datasetId: number;
	/** stores the label before the dataset joins; false keeps it out */
	beforeAdd: () => Promise<boolean>;
	/** B toggles it while its step is open and no crop review holds the keys */
	active: boolean;
	/** the decision the benchmark keeps as the dataset's label */
	children?: ReactNode;
}

const DATASET_EVALUATION: BenchmarkRef = { check_key: "dataset_evaluation", layer: null };

/** The dataset evaluation's decision in the benchmark panel: "Benchmark (B)" Yes or No on top
 * (operators only) adds the dataset to the open dataset evaluation benchmark labeled with the
 * decision, or takes it out again. The crop review has the same panel per crop. */
export default function BenchmarkToggle({ datasetId, beforeAdd, active, children }: BenchmarkToggleProps) {
	const benchmark = useBenchmarkToggle(DATASET_EVALUATION, datasetId);
	const toggle = async () => {
		if (!benchmark || benchmark.pending) return;
		if (!benchmark.isMember(null) && !(await beforeAdd())) return;
		await benchmark.toggle(null);
	};
	useAuditShortcuts({ b: () => void toggle() }, active && !!benchmark);
	return (
		<BenchmarkPanel
			member={benchmark ? benchmark.isMember(null) : null}
			onToggle={() => void toggle()}
			disabled={!benchmark || benchmark.pending}
			name="dataset evaluation benchmark"
			testId="benchmark-toggle"
		>
			{children}
		</BenchmarkPanel>
	);
}
