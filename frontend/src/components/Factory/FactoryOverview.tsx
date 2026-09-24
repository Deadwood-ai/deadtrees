import { Link } from "react-router-dom";
import { useFactoryOperations } from "../../hooks/useFactory";
import FactoryNorthStar from "./FactoryNorthStar";

/** One line that says whether anything needs care, without pulling triage onto the daily view. */
function AttentionLine() {
	const operations = useFactoryOperations();
	const total = operations.data?.attention_total ?? null;
	const contributors = operations.data?.attention_contributors ?? null;
	const tone = total ? "border-amber-200 bg-amber-50 text-amber-900" : "border-gray-200/60 bg-white text-gray-700";
	return (
		<div className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-5 py-3 text-sm shadow-sm ${tone}`} data-testid="factory-attention-line">
			<span>
				{operations.isLoading
					? "Checking what needs attention…"
					: operations.isError && !operations.data
						? "Could not check what needs attention."
						: total
							? `${total.toLocaleString()} dataset${total === 1 ? "" : "s"} need attention${contributors ? ` across ${contributors} contributor${contributors === 1 ? "" : "s"}` : ""}.`
							: "Nothing needs attention right now."}
			</span>
			<Link to="/factory/operations" className="font-medium">
				Open Operations →
			</Link>
		</div>
	);
}

/** Daily first screen: north-star outcomes, then a single pointer into operations. */
export default function FactoryOverview() {
	return (
		<div className="space-y-6" data-testid="factory-overview">
			<AttentionLine />
			<FactoryNorthStar />
		</div>
	);
}
