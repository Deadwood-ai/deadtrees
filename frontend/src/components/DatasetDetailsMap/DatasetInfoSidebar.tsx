import { useState } from "react";
import { Typography, Tooltip, Tag, Popover } from "antd";
import { ClockCircleOutlined, DownOutlined, EnvironmentOutlined, InfoCircleOutlined, RightOutlined, WarningOutlined } from "@ant-design/icons";
import type { IDataset } from "../../types/dataset";
import type { PhenologyMetadata } from "../../types/phenology";
import countryList from "../../utils/countryList";
import { formatGroundResolution, formatOrthoFileSize, isGeonadirDataset, getTruncatedAuthorDisplay } from "../../utils/datasetUtils";
import { sanitizeText } from "../../utils/textUtils";
import PublicationLink from "../PublicationLink";
import PhenologyBar from "../PhenologyBar/PhenologyBar";
import DatasetNavigation from "./DatasetNavigation";
import { palette } from "../../theme/palette";
import { getBiomeEmoji, getBiomeTagColor, truncateBiomeLabel } from "../../utils/biomeDisplay";
import { useAcquisitionDateDecisions, useAcquisitionDateEstimate } from "../../hooks/useAcquisitionDateEstimate";
import {
  datasetDateSuggestion,
  decisionDistribution,
  describeModelType,
  formatDateParts,
  formatIsoDate,
  modelSuggestedDecision,
} from "../../utils/acquisitionDate";
import { formatAcquisitionDate } from "../DatasetAudit/auditConstants";
import AcquisitionDateEvidence from "../AcquisitionDate/AcquisitionDateEvidence";
import DatasetAccessSection from "../DatasetAccess/DatasetAccessSection";
import { useDatasetGroundResolution } from "../../hooks/useDatasets";
import { useDatasetAuditSummary } from "../../hooks/useDatasetAuditSummary";
import { auditSettled, cropReasoning, georefFinding, predictionFinding } from "../../utils/datasetAuditSummary";
import type { ICropReasoning } from "../../types/auditChecks";

interface DatasetInfoSidebarProps {
  dataset: IDataset;
  phenologyData: PhenologyMetadata | null | undefined;
  isPhenologyLoading: boolean;
  /** the probability to be in the maximum greenness period at the acquisition date, or null */
  phenologyProbability: number | null | undefined;
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
        <div className="h-4 w-16 animate-pulse rounded bg-gray-200" />
      ) : (
        <Typography.Text data-testid="dataset-ground-resolution">{formatGroundResolution(gsdCm)}</Typography.Text>
      )}
    </InfoRow>
  );
};

const pad2 = (v: number) => String(v).padStart(2, "0");
const isoOf = (y: number | null, m: number | null, d: number | null) => (y && m && d ? `${y}-${pad2(m)}-${pad2(d)}` : null);

/** Acquisition date with its provenance: a date that came from an accepted
 * model suggestion is marked as such, with the reported date and the evidence;
 * a pending suggestion (month missing, or imagery contradicting the reported
 * date) is shown next to the reported date. */
const AcquisitionDateRows = ({ dataset, dateText }: { dataset: IDataset; dateText: string }) => {
  const { data: estimate } = useAcquisitionDateEstimate(dataset.id);
  const { data: decisions } = useAcquisitionDateDecisions(dataset.id);
  const applied = modelSuggestedDecision(decisions, dataset);
  const appliedEvidence = decisionDistribution(applied);
  const suggestion = applied ? null : datasetDateSuggestion(estimate, dataset);
  const reportedIso = isoOf(Number(dataset.aquisition_year), Number(dataset.aquisition_month) || null, Number(dataset.aquisition_day) || null);

  return (
    <>
      <InfoRow label="Acquisition Date" tooltip={applied ? undefined : "Date when the drone imagery was captured."}>
        <Typography.Text strong>{dateText}</Typography.Text>
        {applied && (
          <Popover
            trigger="click"
            title="Date suggested by the date model"
            content={
              appliedEvidence ? (
                <AcquisitionDateEvidence
                  distribution={appliedEvidence}
                  reportedLabel={formatDateParts(applied.reported_year, applied.reported_month, applied.reported_day)}
                  reportedIso={isoOf(applied.reported_year, applied.reported_month, applied.reported_day)}
                  reason={applied.evidence}
                  modelLabel={`${applied.estimate_model_version}, accepted ${applied.source === "automatic" ? "automatically" : "in the audit"} on ${formatIsoDate(applied.decided_at.slice(0, 10))}`}
                />
              ) : null
            }
          >
            <Tag color="gold" className="cursor-pointer" style={{ marginLeft: 6, marginRight: 0 }}>
              model-suggested
            </Tag>
          </Popover>
        )}
      </InfoRow>
      {applied && (
        <InfoRow label="Reported Date" tooltip="The date given at upload, replaced by the model's suggestion.">
          <Typography.Text type="secondary">
            {formatDateParts(applied.reported_year, applied.reported_month, applied.reported_day)}
            {" · "}
            {applied.evidence.suggestion_reason === "missing_month" ? "incomplete" : "contradicted by the imagery"}
          </Typography.Text>
        </InfoRow>
      )}
      {estimate && suggestion && (
        <InfoRow label="Suggested Date">
          <Popover
            trigger="click"
            title="Suggestion of the date model"
            content={
              <AcquisitionDateEvidence
                distribution={estimate}
                reportedLabel={formatAcquisitionDate(dataset)}
                reportedIso={reportedIso}
                reason={estimate}
                modelLabel={`${estimate.model_version}, ${describeModelType(estimate)}`}
              />
            }
          >
            <Typography.Text className="cursor-pointer">
              {suggestion.reason === "mismatch" && <WarningOutlined style={{ color: palette.state.warning, marginRight: 4 }} />}~
              {formatIsoDate(suggestion.date, { day: "numeric", month: "long", year: "numeric" })}{" "}
              <Typography.Text type="secondary" underline>
                why?
              </Typography.Text>
            </Typography.Text>
          </Popover>
        </InfoRow>
      )}
    </>
  );
};

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

// === Audit ===

/** An audit finding not there yet: the review is still open. */
const Pending = () => (
  <span className="inline-flex items-center gap-1.5 text-gray-500">
    <ClockCircleOutlined className="animate-pulse" />
    Pending
  </span>
);

/** The georeferencing finding of the audit, as a row of the environmental panel. */
const GeorefRow = ({ datasetId }: { datasetId: number }) => {
  const { data: summary, isLoading } = useDatasetAuditSummary(datasetId);
  return (
    <InfoRow label="Georeferencing" tooltip="Median offset between orthophoto and available reference aerial or satellite imagery.">
      {isLoading ? (
        <div className="h-4 w-16 animate-pulse rounded bg-gray-200" />
      ) : (
        <Typography.Text data-testid="dataset-audit-georef">{auditSettled(summary) ? georefFinding(summary) : <Pending />}</Typography.Text>
      )}
    </InfoRow>
  );
};

const CROPS_TOOLTIP =
  "Of the sample crops the automated audit checked (e.g. 2/16): how many show major errors (20% or more of the crop wrong) and minor ones. Click for the model's reasoning.";

/** One prediction's quality: its crop counts, and on click the model's reasoning on the crops
 * it found errors on. */
const QualityRow = ({ label, finding, reasoning, testId }: { label: string; finding: React.ReactNode; reasoning: ICropReasoning[]; testId: string }) => {
  const [open, setOpen] = useState(false);
  const canOpen = reasoning.length > 0;
  return (
    <div data-testid={testId}>
      <div className={canOpen ? "cursor-pointer" : ""} onClick={() => canOpen && setOpen((o) => !o)}>
        <InfoRow label={label} tooltip={CROPS_TOOLTIP}>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Typography.Text>{finding}</Typography.Text>
            {canOpen && (open ? <DownOutlined className="text-[10px] text-gray-400" /> : <RightOutlined className="text-[10px] text-gray-400" />)}
          </span>
        </InfoRow>
      </div>
      {open && (
        <ol className="mb-0 mt-2 max-h-64 space-y-2 overflow-y-auto pl-5 text-xs text-gray-600" data-testid={`${testId}-reasoning`}>
          {reasoning.map((crop, i) => (
            <li key={i}>
              <span className={`font-medium ${crop.verdict === "major" ? "text-red-600" : "text-amber-600"}`}>{crop.verdict === "major" ? "Major" : "Minor"}</span>
              {": "}
              {cropReasoning(crop)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

/** What the segmentation model audit is and what its categories mean, behind the (i) of its panel. */
const AuditExplanation = () => (
  <div className="max-w-xs space-y-2 text-xs text-gray-600">
    <div>Output of an automated audit with vision language models (VLMs), on a random subset of tiles of the orthophoto.</div>
    <ul className="m-0 list-disc space-y-0.5 pl-4">
      <li>
        <b>Major</b>: 20% or more of the tile's prediction is wrong
      </li>
      <li>
        <b>Minor</b>: errors on under 20% of the tile
      </li>
      <li>
        <b>OK</b>: no relevant error
      </li>
    </ul>
  </div>
);

/** The quality of the predictions, from the automated audit with vision language models: how
 * many sample crops each prediction gets wrong, with the model's reasoning; pending until no
 * review is required. Marked experimental; the (i) explains it. */
const AuditSection = ({ datasetId }: { datasetId: number }) => {
  const { data: summary, isLoading } = useDatasetAuditSummary(datasetId);
  const settled = auditSettled(summary);
  const finding = (total: number | null | undefined, major: number | null | undefined, minor: number | null | undefined) =>
    isLoading ? (
      <span className="inline-block h-4 w-16 animate-pulse rounded bg-gray-200" />
    ) : !settled ? (
      <Pending />
    ) : (
      (predictionFinding(total ?? null, major ?? null, minor ?? null) ?? "Not checked")
    );
  return (
    <Section>
      <div className="space-y-3" data-testid="dataset-audit-findings">
        <div className="flex items-center gap-2">
          <Typography.Text strong>Segmentation model audit</Typography.Text>
          <Popover content={<AuditExplanation />} placement="left" trigger={["hover", "click"]}>
            <InfoCircleOutlined className="cursor-help text-gray-400" aria-label="About the segmentation model audit" data-testid="dataset-audit-info" />
          </Popover>
          <Tag color="purple" style={{ margin: 0, marginLeft: "auto" }}>
            Experimental
          </Tag>
        </div>
        <QualityRow
          label="Deadwood cover quality"
          testId="dataset-audit-deadwood"
          finding={finding(summary?.deadwood_total, summary?.deadwood_major, summary?.deadwood_minor)}
          reasoning={settled ? (summary.deadwood_reasoning ?? []) : []}
        />
        <QualityRow
          label="Tree cover quality"
          testId="dataset-audit-tree-cover"
          finding={finding(summary?.forest_cover_total, summary?.forest_cover_major, summary?.forest_cover_minor)}
          reasoning={settled ? (summary.forest_cover_reasoning ?? []) : []}
        />
      </div>
    </Section>
  );
};

// === Main Sidebar Component ===

export default function DatasetInfoSidebar({
  dataset,
  phenologyData,
  isPhenologyLoading,
  phenologyProbability,
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

        <AcquisitionDateRows
          dataset={dataset}
          dateText={new Date(
            Number(dataset.aquisition_year),
            dataset.aquisition_month ? Number(dataset.aquisition_month) - 1 : 0,
            dataset.aquisition_day ? Number(dataset.aquisition_day) : 1
          ).toLocaleDateString("en-US", {
            year: "numeric",
            ...(dataset.aquisition_month && { month: "long" }),
            ...(dataset.aquisition_day && { day: "numeric" }),
          })}
        />

        <InfoRow label="Phenology">
          <div className="flex w-[210px] items-center gap-2">
            {isPhenologyLoading ? (
              <div className="h-4 w-full animate-pulse rounded bg-gray-200" />
            ) : phenologyData ? (
              <>
                <PhenologyBar
                  className="min-w-0 flex-1"
                  phenologyData={phenologyData}
                  acquisitionYear={dataset.aquisition_year}
                  acquisitionMonth={dataset.aquisition_month}
                  acquisitionDay={dataset.aquisition_day}
                  showTooltips={true}
                  monthsOnHover
                />
                {phenologyProbability != null && (
                  <Tooltip title="Probability to be in the Maximum Greenness Period at the acquisition date" placement="left">
                    <Typography.Text className="shrink-0 tabular-nums" data-testid="dataset-phenology-probability">
                      {Math.round(phenologyProbability * 100)}%
                    </Typography.Text>
                  </Tooltip>
                )}
              </>
            ) : (
              <Typography.Text className="text-gray-500">Not available</Typography.Text>
            )}
          </div>
        </InfoRow>

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
      <AuditSection datasetId={dataset.id} />

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
