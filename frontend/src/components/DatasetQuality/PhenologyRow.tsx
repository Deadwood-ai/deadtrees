import { Tooltip, Typography } from "antd";
import PhenologyBar from "../PhenologyBar/PhenologyBar";
import { useDatasetPhenology } from "../../hooks/usePhenologyData";
import { InlineSkeleton } from "../SectionStates";
import type { DatasetAcquisitionDate } from "./AcquisitionDateRows";
import { InfoRow } from "./InfoRow";

/** The season the image was taken in: the phenology curve of the site with the acquisition
 * date on it, and the probability that it falls in the maximum greenness period. */
export default function PhenologyRow({ dataset }: { dataset: DatasetAcquisitionDate & { phenology_probability?: number | null } }) {
  const { phenology, isLoading, probability } = useDatasetPhenology(dataset);
  return (
    <InfoRow
      label="Phenology"
      tooltip="Where the acquisition date falls in the typical yearly greening of the location. The percentage is the probability that the image was taken in the peak green season, when trees are in full leaf; below 50%, leafless live trees can look dead."
    >
      <div className="flex w-[210px] items-center gap-2">
        {isLoading ? (
          <InlineSkeleton label="Loading phenology" className="h-4 w-full" />
        ) : phenology && dataset.aquisition_year ? (
          <>
            <PhenologyBar
              className="min-w-0 flex-1"
              phenologyData={phenology}
              acquisitionYear={dataset.aquisition_year}
              acquisitionMonth={dataset.aquisition_month ?? undefined}
              acquisitionDay={dataset.aquisition_day ?? undefined}
              showTooltips={true}
              monthsOnHover
            />
            {probability != null && (
              <Tooltip title="Probability to be in the Maximum Greenness Period at the acquisition date" placement="left">
                <Typography.Text className="shrink-0 tabular-nums" data-testid="dataset-phenology-probability">
                  {Math.round(probability * 100)}%
                </Typography.Text>
              </Tooltip>
            )}
          </>
        ) : (
          <Typography.Text className="text-gray-500">Not available</Typography.Text>
        )}
      </div>
    </InfoRow>
  );
}
