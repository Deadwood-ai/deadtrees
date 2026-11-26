import { Typography, Tooltip, Tag } from "antd";
import { EnvironmentOutlined } from "@ant-design/icons";
import type { IDataset } from "../../types/dataset";
import countryList from "../../utils/countryList";
import { formatGroundResolution, formatOrthoFileSize, isGeonadirDataset, getTruncatedAuthorDisplay } from "../../utils/datasetUtils";
import { sanitizeText } from "../../utils/textUtils";
import PublicationLink from "../PublicationLink";
import DatasetNavigation from "./DatasetNavigation";
import { palette } from "../../theme/palette";
import { getBiomeEmoji, getBiomeTagColor, truncateBiomeLabel } from "../../utils/biomeDisplay";
import DatasetAccessSection from "../DatasetAccess/DatasetAccessSection";
import { useDatasetGroundResolution } from "../../hooks/useDatasets";
import { InlineSkeleton } from "../SectionStates";
import { InfoRow } from "../DatasetQuality/InfoRow";
import AcquisitionDateRows from "../DatasetQuality/AcquisitionDateRows";
import PhenologyRow from "../DatasetQuality/PhenologyRow";
import { GeorefRow, PredictionQuality } from "../DatasetQuality/AuditFindings";

interface DatasetInfoSidebarProps {
  dataset: IDataset;
  overlappingDatasets: IDataset[];
  isLoadingOverlapping: boolean;
}

// === Shared Row Components ===

/** Ground resolution of the uploaded orthophoto, before it is reprojected for the map. */
const ResolutionRow = ({ datasetId }: { datasetId: number }) => {
  const { data: gsdCm, isLoading } = useDatasetGroundResolution(datasetId);
  return (
    <InfoRow label="Resolution" tooltip="Ground size of one pixel of the uploaded orthophoto.">
      {isLoading ? (
        <InlineSkeleton label="Loading resolution" className="h-4 w-16" />
      ) : (
        <Typography.Text data-testid="dataset-ground-resolution">{formatGroundResolution(gsdCm)}</Typography.Text>
      )}
    </InfoRow>
  );
};

// Section container with consistent styling
const Section = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <div className={`rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm space-y-3 ${className}`}>
    {children}
  </div>
);

// === Main Sidebar Component ===

export default function DatasetInfoSidebar({
  dataset,
  overlappingDatasets,
  isLoadingOverlapping,
}: DatasetInfoSidebarProps) {
  const isFromGeonadir = isGeonadirDataset(dataset);

  return (
    <div className="flex flex-col gap-4 pb-4">
      {/* Location Header */}
      <Section>
        <div className="flex items-center pb-1">
          <EnvironmentOutlined style={{ fontSize: 24, color: palette.primary[500] }} className="pr-2" />
          <Tooltip
            title={
              <div>
                {dataset.admin_level_3 ? dataset.admin_level_3 : dataset.admin_level_2}
                {dataset.admin_level_1 && <div>{dataset.admin_level_1}</div>}
              </div>
            }
          >
            <Typography.Title style={{ margin: 0 }} level={5}>
              {dataset.admin_level_1
                ? `${dataset.admin_level_3 || dataset.admin_level_2
                  ? `${dataset.admin_level_3 || dataset.admin_level_2}, `
                  : ""
                }${countryList[dataset.admin_level_1 as keyof typeof countryList] ?? ""}`
                : "unknown"}
            </Typography.Title>
          </Tooltip>
        </div>

        <InfoRow label="Author" tooltip={`Dataset author(s): ${dataset.authors?.join(", ") || "Unknown"}${isFromGeonadir ? " (via GeoNadir)" : ""}`}>
          <Typography.Text strong>
            {getTruncatedAuthorDisplay(dataset.authors, isFromGeonadir)}
          </Typography.Text>
        </InfoRow>

        <InfoRow
          label={
            dataset.freidata_doi
              ? "DOI"
              : dataset.citation_doi
                ? dataset.citation_doi.includes("doi.org") ||
                  /^10\.\d{4,}\//.test(dataset.citation_doi) ||
                  dataset.citation_doi.toLowerCase().includes("zenodo")
                  ? "DOI"
                  : "Link"
                : "Reference"
          }
          tooltip="Link to the publication or data repository where this dataset is referenced."
        >
          <div style={{ maxWidth: "160px", overflow: "hidden" }}>
            <PublicationLink freidataDoI={dataset.freidata_doi} citationDoi={dataset.citation_doi} />
          </div>
        </InfoRow>

        <InfoRow label="Uploaded" tooltip="Date when the dataset was uploaded to the platform.">
          <Typography.Text>
            {new Date(dataset.created_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </Typography.Text>
        </InfoRow>

        {/* Visibility and sharing (owner, grantees, private-data operators) */}
        <DatasetAccessSection dataset={dataset} />
      </Section>

      {/* Environmental Context */}
      <Section>
        <InfoRow label="Biome" tooltip={`Ecological biome classification: ${dataset.biome_name || "Unknown"}`}>
          <Tag color={getBiomeTagColor(dataset.biome_name)} style={{ margin: 0 }}>
            {getBiomeEmoji(dataset.biome_name)}{" "}
            {dataset.biome_name
              ? truncateBiomeLabel(dataset.biome_name)
              : "Unknown"}
          </Tag>
        </InfoRow>

        <AcquisitionDateRows dataset={dataset} />

        <PhenologyRow dataset={dataset} />

        <GeorefRow datasetId={dataset.id} />
      </Section>

      {/* Technical Info */}
      <Section>
        <InfoRow label="Platform" tooltip="Type of platform used to capture the imagery (e.g., drone, satellite).">
          <Tag color="default" style={{ margin: 0 }}>{dataset.platform || "Unknown"}</Tag>
        </InfoRow>
        <InfoRow label="License" tooltip="Data license governing usage and distribution rights.">
          <Tag color="blue" style={{ margin: 0 }}>{dataset.license || "Not specified"}</Tag>
        </InfoRow>
        <InfoRow label="File Size" tooltip="Size of the orthomosaic file.">
          <Typography.Text>{formatOrthoFileSize(dataset.ortho_file_size)}</Typography.Text>
        </InfoRow>
        <ResolutionRow datasetId={dataset.id} />
      </Section>


      {/* Additional Information */}
      {dataset.additional_information && (
        <Section>
          <Typography.Text strong>Additional Information</Typography.Text>
          <div className="whitespace-pre-wrap break-words text-sm text-gray-500">
            {sanitizeText(dataset.additional_information)
              .split(/(https?:\/\/[^\s]+)/g)
              .map((part: string, index: number) =>
                part.match(/https?:\/\/[^\s]+/) ? (
                  <Tooltip key={index} title={part}>
                    <a
                      href={part}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-blue-600 underline hover:text-blue-800"
                    >
                      link
                    </a>
                  </Tooltip>
                ) : (
                  part
                )
              )}
          </div>
        </Section>
      )}


      {/* Audit of the predictions */}
      <Section>
        <PredictionQuality datasetId={dataset.id} />
      </Section>

      {/* Navigation */}
      {dataset.id && (
        <DatasetNavigation
          currentDatasetId={dataset.id}
          overlappingDatasets={overlappingDatasets || []}
          isLoading={isLoadingOverlapping}
        />
      )}
    </div>
  );
}
