import { usePhenologyData } from "../../../hooks/usePhenologyData";
import type { IAuditDatasetResult } from "../../../types/auditChecks";
import type { IDataset } from "../../../types/dataset";
import { InlineSkeleton } from "../../SectionStates";
import PhenologyBar from "../../PhenologyBar/PhenologyBar";

/** The phenology indicator's words (utils/phenologyUtils formatPhenologyTooltip): how likely the
 * image was taken in the maximum greenness period. */
export const PHENOLOGY_EXPLAINER =
	"Probability to be in Maximum Greenness Period, from gap-filled VIIRS phenology data (VNP22Q2v001), averaged at 10 km and across years (2013-2022). Ecosystems without annual seasonal dynamics may show incorrect dynamics.";

interface PhenologyStepProps {
	dataset: IDataset;
	result: IAuditDatasetResult | null | undefined;
}

/** Step 5: the probability that the image was taken at peak greenness, and the phenology indicator:
 * the site's greenness over the year with the acquisition date on it. A value to read, nothing to
 * answer. */
export default function PhenologyStep({ dataset, result }: PhenologyStepProps) {
	const { data: phenology, isLoading } = usePhenologyData(dataset.id);
	const p = result?.phenology_probability;
	return (
		<div className="flex flex-col gap-1 text-xs" data-testid="audit-phenology-step">
			<div>
				Probability of peak greenness at the acquisition date: <b>{p == null ? "no data" : `${Math.round(p * 100)}%`}</b>
			</div>
			{isLoading ? (
				<InlineSkeleton label="Loading the phenology indicator" className="h-6 w-full" />
			) : phenology?.phenology_curve ? (
				<div className="mb-6 mt-2 overflow-visible" data-testid="audit-phenology-bar">
					<PhenologyBar
						phenologyData={phenology}
						acquisitionYear={dataset.aquisition_year}
						acquisitionMonth={dataset.aquisition_month}
						acquisitionDay={dataset.aquisition_day}
						showTooltips
					/>
				</div>
			) : (
				<div className="text-gray-500">No phenology curve for this site.</div>
			)}
			<div className="text-[11px] text-gray-500">{PHENOLOGY_EXPLAINER}</div>
		</div>
	);
}
