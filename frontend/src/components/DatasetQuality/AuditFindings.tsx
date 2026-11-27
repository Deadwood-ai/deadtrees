import { useState } from "react";
import { Popover, Tag, Typography } from "antd";
import { DownOutlined, InfoCircleOutlined, RightOutlined } from "@ant-design/icons";
import { useDatasetAOI } from "../../hooks/useDatasetAudit";
import { useDatasetAuditSummary } from "../../hooks/useDatasetAuditSummary";
import { cropReasoning, georefFinding, predictionFinding } from "../../utils/datasetAuditSummary";
import type { ICropReasoning } from "../../types/auditChecks";
import { InlineSkeleton } from "../SectionStates";
import { InfoRow, Pending } from "./InfoRow";

/** The georeferencing finding of the audit. */
export const GeorefRow = ({ datasetId }: { datasetId: number }) => {
  const { data: summary, isLoading } = useDatasetAuditSummary(datasetId);
  return (
    <InfoRow label="Georeferencing" tooltip="How far the image is off compared with reference aerial or satellite imagery: about 90% of the image lies within this distance.">
      {isLoading ? (
        <InlineSkeleton label="Loading georeferencing" className="h-4 w-16" />
      ) : (
        <Typography.Text data-testid="dataset-audit-georef">{georefFinding(summary) ?? <Pending />}</Typography.Text>
      )}
    </InfoRow>
  );
};

/** The area of interest: set, or empty because the AOI model found no usable area. Pending
 * while there is none yet. */
export const AoiRow = ({ datasetId }: { datasetId: number }) => {
  const { data: aoi, isLoading } = useDatasetAOI(datasetId);
  return (
    <InfoRow
      label="Area of interest"
      tooltip="The part of the orthophoto good enough to analyse. A model draws it and auditors correct it; it is empty when the model found no usable area."
    >
      {isLoading ? (
        <InlineSkeleton label="Loading area of interest" className="h-4 w-16" />
      ) : (
        <Typography.Text type={aoi?.noUsableArea ? "warning" : undefined} data-testid="dataset-aoi">
          {!aoi ? <Pending /> : aoi.noUsableArea ? "Empty: no usable area found" : "Set"}
        </Typography.Text>
      )}
    </InfoRow>
  );
};

const CROPS_TOOLTIP =
  "Of the sample tiles the automated audit checked (e.g. 2/16): how many show major errors (20% or more of the tile wrong) and minor ones. Click for the model's reasoning.";

/** One prediction's quality: its tile counts, and on click the model's reasoning on the tiles
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
    <div>Output of an automated check by AI image models, on a random sample of tiles of the orthophoto.</div>
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

/** The quality of the predictions, from the automated audit with AI image models: how many
 * sample tiles each prediction gets wrong, with the model's reasoning. No person reviews them
 * per dataset (tiles are reviewed on a sample): pending until the check ran, then shown.
 * Marked experimental; the (i) explains it. Never the cover estimates themselves. */
export const PredictionQuality = ({ datasetId }: { datasetId: number }) => {
  const { data: summary, isLoading } = useDatasetAuditSummary(datasetId);
  const finding = (total: number | null | undefined, major: number | null | undefined, minor: number | null | undefined) =>
    isLoading ? (
      <InlineSkeleton label="Loading prediction quality" className="h-4 w-16" />
    ) : (
      (predictionFinding(total ?? null, major ?? null, minor ?? null) ?? <Pending />)
    );
  return (
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
        reasoning={summary?.deadwood_reasoning ?? []}
      />
      <QualityRow
        label="Tree cover quality"
        testId="dataset-audit-tree-cover"
        finding={finding(summary?.forest_cover_total, summary?.forest_cover_major, summary?.forest_cover_minor)}
        reasoning={summary?.forest_cover_reasoning ?? []}
      />
    </div>
  );
};
