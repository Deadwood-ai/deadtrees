import type { ReactNode } from "react";
import { message } from "antd";
import { useSaveDatasetReviews } from "../../../hooks/useAuditChecks";
import type { DatasetReviewInput } from "../../../types/auditChecks";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";
import BenchmarkPanel from "./BenchmarkPanel";
import { useBenchmarkToggle } from "./useBenchmarkToggle";

interface BenchmarkToggleProps {
	datasetId: number;
	/** the decision on the page as the dataset's label, or what keeps it from being one */
	label: () => { review?: DatasetReviewInput; problem?: string };
	/** B toggles it while its step is open and no crop review holds the keys */
	active: boolean;
	/** the decision the benchmark keeps as the dataset's label */
	children?: ReactNode;
}

/** The dataset evaluation's decision in the benchmark panel: "Benchmark (B)" Yes or No on top
 * (operators only) stores the decision as the dataset's label, ticked for the dataset evaluation
 * benchmark, or takes the dataset out again. The crop review has the same panel per crop. */
export default function BenchmarkToggle({ datasetId, label, active, children }: BenchmarkToggleProps) {
	const benchmark = useBenchmarkToggle("dataset_evaluation", datasetId);
	const { mutateAsync: save } = useSaveDatasetReviews();
	const addLabel = async () => {
		const { review, problem } = label();
		if (!review || problem) {
			message.error(problem);
			return false;
		}
		try {
			await save([{ ...review, in_benchmark: true }]);
			return true;
		} catch {
			message.error("Your decision was not saved, so the dataset was not added to the benchmark.");
			return false;
		}
	};
	const toggle = () => benchmark && !benchmark.pending && void benchmark.toggle(null, addLabel);
	useAuditShortcuts({ b: toggle }, active && !!benchmark);
	return (
		<BenchmarkPanel
			member={benchmark ? benchmark.isMember(null) : null}
			onToggle={toggle}
			disabled={!benchmark || benchmark.pending}
			name="dataset evaluation benchmark"
			testId="benchmark-toggle"
		>
			{children}
		</BenchmarkPanel>
	);
}
