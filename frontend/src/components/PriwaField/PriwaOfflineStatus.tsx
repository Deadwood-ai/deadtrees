import { CloudSyncOutlined, DisconnectOutlined } from "@ant-design/icons";
import { Button, Popover, Tag, Tooltip, Typography } from "antd";

import { getPriwaOfflineStatusView } from "./priwaOfflineStatusView";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import { usePriwaOfflineStatus } from "./usePriwaOfflineStatus";

interface PriwaOfflineStatusProps {
  syncSummary?: IPriwaSyncSummary;
  onSyncNow?: () => Promise<void>;
}

const getSyncLabel = (syncSummary?: IPriwaSyncSummary) => {
  if (!syncSummary || syncSummary.total === 0) return null;
  if (syncSummary.failed > 0) return `${syncSummary.failed} Sync Fehler`;
  if (syncSummary.syncing > 0) return "Synchronisiert...";
  return `${syncSummary.pending} ausstehend`;
};

export default function PriwaOfflineStatus({
  syncSummary,
  onSyncNow,
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
  const hasSyncWork = (syncSummary?.total ?? 0) > 0;
  const statusTag = (
    <Tag
      className="pointer-events-auto m-0 rounded-md border-0 px-2.5 py-1 text-xs font-medium shadow-sm"
      color={color}
      icon={isOnline ? <CloudSyncOutlined /> : <DisconnectOutlined />}
    >
      {label}
    </Tag>
  );

  if (!hasSyncWork && !serviceWorker.errorMessage) {
    return <Tooltip title={tooltipTitle}>{statusTag}</Tooltip>;
  }

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      content={
        <div className="w-60 space-y-3">
          <div>
            <Typography.Text strong>Syncstatus</Typography.Text>
            <div className="mt-1 text-xs text-gray-500">{tooltipTitle}</div>
          </div>
          {serviceWorker.errorMessage && (
            <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">
              {serviceWorker.errorMessage}
            </div>
          )}
          <Button
            block
            size="small"
            icon={<CloudSyncOutlined spin={!!syncSummary?.syncing} />}
            disabled={!hasSyncWork || !onSyncNow}
            onClick={() => void onSyncNow?.()}
          >
            Jetzt synchronisieren
          </Button>
        </div>
      }
    >
      <button
        type="button"
        className="pointer-events-auto border-0 bg-transparent p-0"
        aria-label="Offline- und Syncstatus anzeigen"
      >
        {statusTag}
      </button>
    </Popover>
  );
}
