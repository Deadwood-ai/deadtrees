import { CloudSyncOutlined, DisconnectOutlined } from "@ant-design/icons";
import { Tag, Tooltip } from "antd";

import { getPriwaOfflineStatusView } from "./priwaOfflineStatusView";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import { usePriwaOfflineStatus } from "./usePriwaOfflineStatus";

interface PriwaOfflineStatusProps {
  syncSummary?: IPriwaSyncSummary;
}

const getSyncLabel = (syncSummary?: IPriwaSyncSummary) => {
  if (!syncSummary || syncSummary.total === 0) return null;
  if (syncSummary.failed > 0) return `${syncSummary.failed} Sync Fehler`;
  if (syncSummary.syncing > 0) return "Synchronisiert...";
  return `${syncSummary.pending} ausstehend`;
};

export default function PriwaOfflineStatus({
  syncSummary,
}: PriwaOfflineStatusProps) {
  const { isOnline, serviceWorker } = usePriwaOfflineStatus();
  const statusView = getPriwaOfflineStatusView(
    serviceWorker.status,
    isOnline,
  );
  const syncLabel = getSyncLabel(syncSummary);
  const label = syncLabel ?? statusView.label;
  const color =
    syncSummary && syncSummary.failed > 0
      ? "error"
      : syncSummary && syncSummary.total > 0
        ? "processing"
        : statusView.color;
  const tooltipTitle =
    serviceWorker.errorMessage ??
    (syncSummary && syncSummary.total > 0
      ? `${syncSummary.pending} ausstehend, ${syncSummary.syncing} wird synchronisiert, ${syncSummary.failed} fehlgeschlagen`
      : statusView.label);

  return (
    <Tooltip title={tooltipTitle}>
      <Tag
        className="pointer-events-auto m-0 rounded-md border-0 px-2.5 py-1 text-xs font-medium shadow-sm"
        color={color}
        icon={isOnline ? <CloudSyncOutlined /> : <DisconnectOutlined />}
      >
        {label}
      </Tag>
    </Tooltip>
  );
}
