import { CloudSyncOutlined, DisconnectOutlined } from "@ant-design/icons";
import { Tag, Tooltip } from "antd";

import { getPriwaOfflineStatusView } from "./priwaOfflineStatusView";
import { usePriwaOfflineStatus } from "./usePriwaOfflineStatus";

export default function PriwaOfflineStatus() {
  const { isOnline, serviceWorker } = usePriwaOfflineStatus();
  const statusView = getPriwaOfflineStatusView(
    serviceWorker.status,
    isOnline,
  );
  const tooltipTitle = serviceWorker.errorMessage ?? statusView.label;

  return (
    <Tooltip title={tooltipTitle}>
      <Tag
        className="pointer-events-auto m-0 rounded-md border-0 px-2.5 py-1 text-xs font-medium shadow-sm"
        color={statusView.color}
        icon={isOnline ? <CloudSyncOutlined /> : <DisconnectOutlined />}
      >
        {statusView.label}
      </Tag>
    </Tooltip>
  );
}
