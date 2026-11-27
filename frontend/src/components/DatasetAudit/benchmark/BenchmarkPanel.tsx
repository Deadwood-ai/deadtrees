import type { ReactNode } from "react";
import { Switch } from "antd";

interface BenchmarkPanelProps {
	/** whether the target is in the benchmark; null when you cannot change it (not an operator) */
	member: boolean | null;
	onToggle: () => void;
	disabled: boolean;
	/** what the benchmark is, for the toggle's title, e.g. "deadwood benchmark" */
	name: string;
	testId: string;
	/** the answers the benchmark keeps as its label */
	children: ReactNode;
}

/** The answers a benchmark keeps as its label, in one outlined panel: the "Benchmark (B)" switch on
 * top, then the answers. Highlighted while the target is in the benchmark. Used for a crop's failure
 * modes and decision, and for the dataset evaluation's decision. */
export default function BenchmarkPanel({ member, onToggle, disabled, name, testId, children }: BenchmarkPanelProps) {
	return (
		<div
			className={`flex flex-col gap-3 rounded-lg border border-solid p-2.5 ${member ? "border-indigo-300 bg-indigo-50/70" : "border-gray-300 bg-white"}`}
			data-testid={`${testId}-panel`}
			data-member={member ?? undefined}
		>
			{member !== null && (
				<label className="flex items-center justify-between gap-2" title={`Adds it to the ${name}, labeled with the answers below`} data-testid={testId}>
					<span className="text-[11px] font-bold uppercase tracking-wide text-gray-700">Benchmark (B)</span>
					<Switch size="small" checked={member} onChange={onToggle} disabled={disabled} aria-label={`In the ${name}`} />
				</label>
			)}
			{children}
		</div>
	);
}
