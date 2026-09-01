import {
  CheckCircleOutlined,
  DisconnectOutlined,
  DownloadOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";

import { getPriwaOfflineStatusView } from "./priwaOfflineStatusView";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import { usePriwaOfflineStatus } from "./usePriwaOfflineStatus";

interface PriwaOfflineStatusProps {
  active: boolean;
  coverageRatio: number;
  hasAreas: boolean;
  isCacheAuditComplete: boolean;
  isSupported: boolean;
  needsRefresh: boolean;
  syncSummary?: IPriwaSyncSummary;
  onToggle: () => void;
}

const getSyncLabel = (summary?: IPriwaSyncSummary) => {
  if (!summary || summary.total === 0) return null;
  if (summary.failed > 0) return `${summary.failed} Sync-Fehler`;
  if (summary.syncing > 0) return "Synchronisiert...";
  return `${summary.pending} ausstehend`;
};

export default function PriwaOfflineStatus({
  active,
  coverageRatio,
  hasAreas,
  isCacheAuditComplete,
  isSupported,
  needsRefresh,
  syncSummary,
  onToggle,
}: PriwaOfflineStatusProps) {
  const { isOnline, serviceWorker } = usePriwaOfflineStatus();
  const statusView = getPriwaOfflineStatusView({
    serviceWorkerStatus: serviceWorker.status,
    isOnline,
    isSupported,
    isCacheAuditComplete,
    hasAreas,
    needsRefresh,
    coverageRatio,
  });
  const syncLabel = getSyncLabel(syncSummary);
  const label = syncLabel
    ? `${statusView.label} · ${syncLabel}`
    : statusView.label;
  const color =
    syncSummary && syncSummary.failed > 0
      ? "error"
      : syncSummary && syncSummary.total > 0
        ? "processing"
        : statusView.color;
  const icon = !isOnline ? (
    <DisconnectOutlined />
  ) : statusView.color === "processing" ? (
    <LoadingOutlined spin />
  ) : statusView.color === "success" ? (
    <CheckCircleOutlined />
  ) : (
    <DownloadOutlined />
  );

  return (
    <button
      type="button"
      className="pointer-events-auto border-0 bg-transparent p-0"
      aria-label={`${label}: Offline-Karten ${active ? "schließen" : "öffnen"}`}
      aria-pressed={active}
      onClick={onToggle}
    >
      <Tag
        className="m-0 cursor-pointer rounded-md border-0 px-2.5 py-1 text-xs font-medium shadow-sm"
        color={color}
        icon={icon}
      >
        {label}
      </Tag>
    </button>
  );
}
