import { Popover, Tag, Typography } from "antd";
import { WarningOutlined } from "@ant-design/icons";
import { palette } from "../../theme/palette";
import { useAcquisitionDateDecisions, useAcquisitionDateEstimate } from "../../hooks/useAcquisitionDateEstimate";
import { useDatasetAuditSummary } from "../../hooks/useDatasetAuditSummary";
import { decisionDistribution, describeModelType, formatDateParts, formatIsoDate, modelSuggestedDecision } from "../../utils/acquisitionDate";
import { formatAcquisitionDate } from "../DatasetAudit/auditConstants";
import AcquisitionDateEvidence from "../AcquisitionDate/AcquisitionDateEvidence";
import { InfoRow } from "./InfoRow";
import { AERIALSTAMP_CITATION } from "../../data/citations";

export interface DatasetAcquisitionDate {
  id: number;
  aquisition_year?: number | string | null;
  aquisition_month?: number | string | null;
  aquisition_day?: number | string | null;
}

const pad2 = (v: number) => String(v).padStart(2, "0");
const isoOf = (y: number | null, m: number | null, d: number | null) => (y && m && d ? `${y}-${pad2(m)}-${pad2(d)}` : null);

/** The reported date as the dataset page writes it: "June 2024", "June 3, 2024" or "2024". */
const dateText = (dataset: DatasetAcquisitionDate) =>
  new Date(
    Number(dataset.aquisition_year),
    dataset.aquisition_month ? Number(dataset.aquisition_month) - 1 : 0,
    dataset.aquisition_day ? Number(dataset.aquisition_day) : 1,
  ).toLocaleDateString("en-US", {
    year: "numeric",
    ...(dataset.aquisition_month && { month: "long" }),
    ...(dataset.aquisition_day && { day: "numeric" }),
  });

/** Acquisition date with its provenance: a date that came from an accepted
 * model suggestion is marked as such, with the reported date and the evidence;
 * the audit's suggested date (the date check's, or a reviewer's correction of
 * it) is shown next to the reported date, with the estimate as evidence. */
export default function AcquisitionDateRows({ dataset }: { dataset: DatasetAcquisitionDate }) {
  const { data: estimate } = useAcquisitionDateEstimate(dataset.id);
  const { data: decisions } = useAcquisitionDateDecisions(dataset.id);
  const applied = modelSuggestedDecision(decisions, dataset);
  const appliedEvidence = decisionDistribution(applied);
  const { data: audit } = useDatasetAuditSummary(dataset.id);
  const suggested = applied || !audit?.date_replace ? null : audit.date_new;
  const reportedIso = isoOf(Number(dataset.aquisition_year), Number(dataset.aquisition_month) || null, Number(dataset.aquisition_day) || null);

  return (
    <>
      <InfoRow label="Acquisition Date" tooltip={applied ? undefined : "Date when the drone imagery was captured."}>
        <Typography.Text strong>{dateText(dataset)}</Typography.Text>
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
      {estimate && suggested && (
        <InfoRow label="Suggested Date" tooltip="The date the date model reads from the imagery, where it disagrees with the reported date.">
          <Popover
            trigger="click"
            title="Suggestion of the date model"
            content={
              <div className="flex flex-col gap-1.5">
                <AcquisitionDateEvidence
                  distribution={estimate}
                  reportedLabel={formatAcquisitionDate(dataset)}
                  reportedIso={reportedIso}
                  reason={estimate}
                  modelLabel={`${estimate.model_version}, ${describeModelType(estimate)}`}
                />
                <a href={AERIALSTAMP_CITATION.url} target="_blank" rel="noopener noreferrer" className="text-xs" data-testid="aerialstamp-citation">
                  Mosig et al., 2026, AerialStamp (preprint)
                </a>
              </div>
            }
          >
            <Typography.Text className="cursor-pointer">
              {estimate.suggestion_reason === "mismatch" && <WarningOutlined style={{ color: palette.state.warning, marginRight: 4 }} />}~
              {formatIsoDate(suggested, { day: "numeric", month: "long", year: "numeric" })}{" "}
              <Typography.Text type="secondary" underline>
                why?
              </Typography.Text>
            </Typography.Text>
          </Popover>
        </InfoRow>
      )}
    </>
  );
}
