import React, { useMemo } from "react";
import { Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import type { DatasetAuditUserInfo } from "../hooks/useDatasetAudit";

type Props = {
  datasetId: number;
  audit?: Partial<DatasetAuditUserInfo> | null;
  size?: "small" | "default";
};

const assessmentToVisual = (assessment: DatasetAuditUserInfo["final_assessment"]) => {
  switch (assessment) {
    case "no_issues":
      return { color: "green", text: "✅ Audited" };
    case "fixable_issues":
      return { color: "gold", text: "🔧 Issues" };
    case "exclude_completely":
      return { color: "red", text: "🚫 Excluded" };
    default:
      return { color: "default", text: "Audited" };
  }
};

function renderBool(value: boolean | null | undefined): string {
  if (value === true) return "✅ Yes";
  if (value === false) return "❌ No";
  return "—";
}

function renderQuality(value: string | null | undefined): string {
  if (!value) return "—";
  switch (value) {
    case "great":
      return "🟢 great";
    case "sentinel_ok":
      return "🟡 ok";
    case "bad":
      return "🔴 bad";
    default:
      return value;
  }
}

function buildTooltip(audit: DatasetAuditUserInfo) {
  const acquisitionHint = audit.has_valid_phenology
    ? "Acquisition during growing season"
    : audit.has_valid_phenology === false
      ? "Acquisition likely outside growing season"
      : "Acquisition season unknown";

  const rows = [
    { label: "Final assessment", value: assessmentToVisual(audit.final_assessment).text },
    { label: "Audit date", value: audit.audit_date ? dayjs(audit.audit_date).format("YYYY-MM-DD") : "—" },
    { label: "Georeferenced", value: renderBool(audit.is_georeferenced) },
    { label: "Valid acquisition date", value: renderBool(audit.has_valid_acquisition_date) },
    { label: "Phenology", value: `${renderBool(audit.has_valid_phenology)}`, hint: acquisitionHint },
    { label: "Deadwood quality", value: renderQuality(audit.deadwood_quality || null) },
    { label: "Forest cover quality", value: renderQuality(audit.forest_cover_quality || null) },
  ];

  return (
    <div className="text-sm">
      <table className="w-full">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-700 last:border-0">
              <td className="py-1 pr-4 text-gray-300">{row.label}</td>
              <td className="py-1 text-right font-medium">
                {row.value}
                {row.hint && <div className="text-xs font-normal text-gray-400">({row.hint})</div>}
              </td>
            </tr>
          ))}
          {audit.has_cog_issue && (
            <tr className="border-b border-gray-700 last:border-0">
              <td className="py-1 pr-4 text-gray-300">COG issues</td>
              <td className="py-1 text-right font-medium">{audit.cog_issue_notes}</td>
            </tr>
          )}
          {audit.has_thumbnail_issue && (
            <tr className="border-b border-gray-700 last:border-0">
              <td className="py-1 pr-4 text-gray-300">Thumbnail issues</td>
              <td className="py-1 text-right font-medium">{audit.thumbnail_issue_notes}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const AuditBadge: React.FC<Props> = ({ datasetId: _datasetId, audit: auditProp }) => {
  const audit = (auditProp ?? null) as DatasetAuditUserInfo | null;
  const show = Boolean(audit && audit.final_assessment);

  const visual = useMemo(() => assessmentToVisual(audit?.final_assessment ?? null), [audit?.final_assessment]);

  if (!show) return null;

  return (
    <Tooltip title={audit ? buildTooltip(audit) : undefined} styles={{ root: { maxWidth: 360 } }}>
      <Tag color={visual.color}>{visual.text}</Tag>
    </Tooltip>
  );
};

export default AuditBadge;
