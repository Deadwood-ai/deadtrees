import { Typography, Tooltip, Tag } from "antd";
import { EnvironmentOutlined, CheckCircleOutlined, ExclamationCircleOutlined, WarningOutlined, ClockCircleOutlined } from "@ant-design/icons";
import type { IDataset } from "../../types/dataset";
import type { PhenologyMetadata } from "../../types/phenology";
import countryList from "../../utils/countryList";
import { isGeonadirDataset, getTruncatedAuthorDisplay } from "../../utils/datasetUtils";
import { sanitizeText } from "../../utils/textUtils";
import PublicationLink from "../PublicationLink";
import PhenologyBar from "../PhenologyBar/PhenologyBar";
import DatasetNavigation from "./DatasetNavigation";
import { palette } from "../../theme/palette";
import { getBiomeEmoji, getBiomeTagColor, truncateBiomeLabel } from "../../utils/biomeDisplay";

interface DatasetInfoSidebarProps {
  dataset: IDataset;
  phenologyData: PhenologyMetadata | null | undefined;
  isPhenologyLoading: boolean;
  auditInfo: AuditInfo | null | undefined;
  overlappingDatasets: IDataset[];
  isLoadingOverlapping: boolean;
}

// === Shared Row Components ===

interface InfoRowProps {
  label: string;
  children: React.ReactNode;
  tooltip?: string;
}

const InfoRow = ({ label, children, tooltip }: InfoRowProps) => {
  const content = (
    <div className={`flex justify-between items-center gap-4 rounded hover:bg-black/5 transition-colors px-1 -mx-1 ${tooltip ? "cursor-help" : ""}`}>
      <Typography.Text className="text-gray-600 shrink-0">{label}</Typography.Text>
      <div className="text-right min-w-0">{children}</div>
    </div>
  );

  if (tooltip) {
    return (
      <Tooltip title={tooltip} placement="left">
        {content}
      </Tooltip>
    );
  }

  return content;
};

// Section container with consistent styling
const Section = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <div className={`rounded-2xl border border-gray-200/60 bg-white p-5 shadow-sm space-y-3 ${className}`}>
    {children}
  </div>
);

// === Audit Info Components ===

const qualityConfig = {
  great: { icon: "🟢", label: "Great" },
  sentinel_ok: { icon: "🟡", label: "OK" },
  bad: { icon: "🔴", label: "Poor" },
};

const assessmentConfig = {
  no_issues: {
    icon: <CheckCircleOutlined />,
    bgColor: "bg-green-100",
    textColor: "text-green-700",
    label: "Quality Verified",
    rowLabel: "Ready",
    rowIcon: "🟢",
  },
  fixable_issues: {
    icon: <ExclamationCircleOutlined />,
    bgColor: "bg-yellow-100",
    textColor: "text-yellow-700",
    label: "Has Fixable Issues",
    rowLabel: "Fixable",
    rowIcon: "🟡",
  },
  exclude_completely: {
    icon: <WarningOutlined />,
    bgColor: "bg-red-100",
    textColor: "text-red-700",
    label: "Excluded from Analysis",
    rowLabel: "Excluded",
    rowIcon: "🔴",
  },
};

const tooltips = {
  forestCover: "Quality of the AI forest cover segmentation. Great = highly accurate boundaries.",
  deadwood: "Quality of the AI deadwood detection. Great = dead trees accurately identified.",
  finalAssessment: "Overall quality assessment. Ready = suitable for analysis, Fixable = has correctable issues, Excluded = not suitable.",
};

interface QualityValueProps {
  quality: string | null | undefined;
}

const QualityValue = ({ quality }: QualityValueProps) => {
  const config = quality ? qualityConfig[quality as keyof typeof qualityConfig] : null;
  if (!config) return <Typography.Text className="text-gray-400">—</Typography.Text>;

  return (
    <span className="flex items-center gap-1.5">
      <Typography.Text>{config.label}</Typography.Text>
      <span>{config.icon}</span>
    </span>
  );
};

const BooleanValue = ({ value }: { value: boolean | null | undefined }) => {
  if (value === null || value === undefined) {
    return <Typography.Text className="text-gray-400">—</Typography.Text>;
  }

  return (
    <span className="flex items-center gap-1.5">
      <Typography.Text>{value ? "Yes" : "No"}</Typography.Text>
      <span>{value ? "🟢" : "🔴"}</span>
    </span>
  );
};

interface AuditSectionProps {
  audit: AuditInfo | null | undefined;
}

const AuditSection = ({ audit }: AuditSectionProps) => {
  // Show pending state
  if (!audit || !audit.final_assessment) {
    return (
      <Section>
        <div className="flex items-center gap-2 text-gray-500">
          <ClockCircleOutlined className="animate-pulse" />
          <Typography.Text strong>Audit Pending</Typography.Text>
        </div>
        <Typography.Text className="text-xs text-gray-400">
          Quality information will appear here once reviewed.
        </Typography.Text>
      </Section>
    );
  }

  const config = assessmentConfig[audit.final_assessment as keyof typeof assessmentConfig] || assessmentConfig.no_issues;

  return (
    <div className="rounded-2xl border border-gray-200/60 bg-white overflow-hidden shadow-sm">
      {/* Colored header */}
      <div className={`${config.bgColor} px-5 py-3 flex items-center gap-2 ${config.textColor}`}>
        {config.icon}
        <Typography.Text strong className={config.textColor}>
          {config.label}
        </Typography.Text>
      </div>

      {/* Content rows */}
      <div className="p-5 space-y-3">
        <InfoRow label="Forest Cover Prediction" tooltip={tooltips.forestCover}>
          <QualityValue quality={audit.forest_cover_quality} />
        </InfoRow>
        <InfoRow label="Deadwood Prediction" tooltip={tooltips.deadwood}>
          <QualityValue quality={audit.deadwood_quality} />
        </InfoRow>
        <InfoRow label="Final Assessment" tooltip={tooltips.finalAssessment}>
          <span className="flex items-center gap-1.5">
            <Typography.Text>{config.rowLabel}</Typography.Text>
            <span>{config.rowIcon}</span>
          </span>
        </InfoRow>
      </div>
    </div>
  );
};

type AuditInfo = {
  final_assessment: "no_issues" | "fixable_issues" | "exclude_completely" | "ready" | null;
  forest_cover_quality: "great" | "sentinel_ok" | "bad" | null;
  deadwood_quality: "great" | "sentinel_ok" | "bad" | null;
  has_valid_phenology: boolean | null | undefined;
};

// === Main Sidebar Component ===

export default function DatasetInfoSidebar({
  dataset,
  phenologyData,
  isPhenologyLoading,
  auditInfo,
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

        <InfoRow label="Acquisition Date" tooltip="Date when the drone imagery was captured.">
          <Typography.Text strong>
            {new Date(
              Number(dataset.aquisition_year),
              dataset.aquisition_month ? Number(dataset.aquisition_month) - 1 : 0,
              dataset.aquisition_day ? Number(dataset.aquisition_day) : 1
            ).toLocaleDateString("en-US", {
              year: "numeric",
              ...(dataset.aquisition_month && { month: "long" }),
              ...(dataset.aquisition_day && { day: "numeric" }),
            })}
          </Typography.Text>
        </InfoRow>

        <InfoRow label="Phenology">
          <div className="w-[180px]">
            {isPhenologyLoading ? (
              <div className="h-4 w-full animate-pulse rounded bg-gray-200" />
            ) : phenologyData ? (
              <PhenologyBar
                phenologyData={phenologyData}
                acquisitionYear={dataset.aquisition_year}
                acquisitionMonth={dataset.aquisition_month}
                acquisitionDay={dataset.aquisition_day}
                showTooltips={true}
              />
            ) : (
              <Typography.Text className="text-gray-500">Not available</Typography.Text>
            )}
          </div>
        </InfoRow>
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
          <Typography.Text>
            {dataset.ortho_file_size >= 1024
              ? `${(dataset.ortho_file_size / 1024).toFixed(1)} GB`
              : `${dataset.ortho_file_size.toFixed(0)} MB`}
          </Typography.Text>
        </InfoRow>
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

      {/* Audit Info */}
      <AuditSection audit={auditInfo} />

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
