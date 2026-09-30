import { Typography } from "antd";
import type { IDoyDistribution } from "../../types/acquisitionDate";
import { evidenceText, formatIsoDate, joinYearWrap } from "../../utils/acquisitionDate";
import AcquisitionDateDistribution from "./AcquisitionDateDistribution";

interface AcquisitionDateEvidenceProps {
  distribution: IDoyDistribution;
  reportedLabel: string;
  /** ISO date of the reported date, when it has a day */
  reportedIso: string | null;
  reason: { suggestion_reason?: "missing_month" | "mismatch" | null; recorded_offset_days?: number | null; n_modes?: number };
  modelLabel: string;
}

/** Why the date model doubts (or accepts) a reported date: the reason in
 * words, the reported date, the estimate's likely range and its distribution. */
export default function AcquisitionDateEvidence({ distribution, reportedLabel, reportedIso, reason, modelLabel }: AcquisitionDateEvidenceProps) {
  const ranges = joinYearWrap(distribution.hdi["80"] ?? [])
    .map(([s, e]) => `${formatIsoDate(s, { day: "numeric", month: "short" })} – ${formatIsoDate(e, { day: "numeric", month: "short" })}`)
    .join(", ");
  return (
    <div className="w-[300px] text-xs">
      <Typography.Paragraph className="mb-1 text-xs">{evidenceText(reason)}</Typography.Paragraph>
      <div className="mb-1 text-gray-600">
        Reported: <b>{reportedLabel}</b> · Estimate: <b>{formatIsoDate(distribution.predicted_date)}</b>
      </div>
      <AcquisitionDateDistribution estimate={distribution} recordedDate={reportedIso} height={84} />
      <div className="mt-1 text-[11px] text-gray-500">
        80% likely: {ranges} · {modelLabel}
      </div>
    </div>
  );
}
