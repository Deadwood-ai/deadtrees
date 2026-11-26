import type { ReactNode } from "react";
import { Button, Checkbox, Input, Select } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { NO_FILTERS, type IAuditListFilters } from "../../../utils/auditReviewList";
import { DECISION_LABELS, GEOREF_LABELS } from "../../../utils/auditReview";
import type { EvaluationDecision, GeorefStatus } from "../../../types/auditChecks";

interface AuditListFiltersProps {
	filters: IAuditListFilters;
	onChange: (patch: Partial<IAuditListFilters>) => void;
	countries: string[];
	/** processing statuses present in the list */
	stages: string[];
	reviewers: string[];
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
	<label className="flex w-full flex-col gap-1 text-xs text-gray-500 md:w-auto">
		{label}
		{children}
	</label>
);

const words = (value: string) => value.replace(/_/g, " ");
const MAJOR_SHARES = [1, 10, 25, 50];

/** The list's filters: the dataset, its processing, each check's output, and the review. */
export default function AuditListFilters({ filters, onChange, countries, stages, reviewers }: AuditListFiltersProps) {
	const select = <K extends keyof IAuditListFilters>(key: K, width: number, options: { label: string; value: string | number }[], placeholder: string) => (
		<Select
			value={filters[key] as string | number | null}
			onChange={(value) => onChange({ [key]: value ?? null } as Partial<IAuditListFilters>)}
			allowClear
			showSearch
			optionFilterProp="label"
			placeholder={placeholder}
			className="w-full md:w-auto"
			style={{ minWidth: width }}
			options={options}
		/>
	);
	return (
		<div className="flex flex-col gap-3" data-testid="audit-list-filters">
			<div className="flex flex-wrap items-end gap-3">
				<Field label="Dataset ID">
					<Input value={filters.id} onChange={(e) => onChange({ id: e.target.value })} prefix={<SearchOutlined />} placeholder="ID" allowClear style={{ width: 120 }} />
				</Field>
				<Field label="Country">{select("country", 160, countries.map((c) => ({ label: c, value: c })), "All countries")}</Field>
				<Field label="Processing">
					{select(
						"stage",
						160,
						[{ label: "Finished", value: "finished" }, { label: "Not finished", value: "unfinished" }, ...stages.map((s) => ({ label: words(s), value: s }))],
						"Any stage",
					)}
				</Field>
				<Field label="Evaluation">
					{select(
						"decision",
						130,
						[...(Object.keys(DECISION_LABELS) as EvaluationDecision[]).map((d) => ({ label: DECISION_LABELS[d], value: d })), { label: "None", value: "none" }],
						"Any decision",
					)}
				</Field>
				<Field label="Georeferencing">
					{select(
						"georef",
						160,
						[...(Object.keys(GEOREF_LABELS) as GeorefStatus[]).map((s) => ({ label: GEOREF_LABELS[s], value: s })), { label: "Not run", value: "none" }],
						"Any status",
					)}
				</Field>
				<Field label="Date replaced">
					{select("dateReplaced", 110, [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], "Either")}
				</Field>
				<Field label="Major crops">
					{select("majorShare", 120, MAJOR_SHARES.map((p) => ({ label: `≥ ${p}%`, value: p })), "Any share")}
				</Field>
				<Field label="Reviewed by">{select("reviewedBy", 180, reviewers.map((r) => ({ label: r, value: r })), "Anyone")}</Field>
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<Checkbox checked={filters.reviewRequired} onChange={(e) => onChange({ reviewRequired: e.target.checked })}>
					Review required
				</Checkbox>
				<Checkbox checked={filters.inBenchmark} onChange={(e) => onChange({ inBenchmark: e.target.checked })}>
					In benchmark
				</Checkbox>
				<Button size="small" onClick={() => onChange(NO_FILTERS)}>
					Clear filters
				</Button>
			</div>
		</div>
	);
}
