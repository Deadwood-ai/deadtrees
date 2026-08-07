import { Button, Empty, List, Popconfirm, Space, Tag, Typography } from "antd";

import type { IPriwaWarnkarteVersion } from "../../api/priwaWarnkarte";
import { formatPriwaWarnkarteDate } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteVersionListProps {
  versions: IPriwaWarnkarteVersion[];
  previewVersionId: string | null;
  isBusy: boolean;
  onPreview: (versionId: string) => void;
  onPublish: (versionId: string) => void;
}

export default function PriwaWarnkarteVersionList({
  versions,
  previewVersionId,
  isBusy,
  onPreview,
  onPublish,
}: PriwaWarnkarteVersionListProps) {
  if (versions.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Noch keine Warnkarten importiert"
      />
    );
  }

  return (
    <List
      dataSource={versions}
      renderItem={(version) => (
        <List.Item
          actions={[
            <Button
              key="preview"
              size="small"
              disabled={isBusy}
              onClick={() => onPreview(version.id)}
            >
              Vorschau
            </Button>,
            <Popconfirm
              key="publish"
              title="Diese Version als aktive Warnkarte veröffentlichen?"
              description="Die bisherige Version bleibt erhalten und kann erneut veröffentlicht werden."
              okText="Veröffentlichen"
              cancelText="Abbrechen"
              onConfirm={() => onPublish(version.id)}
            >
              <Button size="small" type="primary" danger disabled={isBusy}>
                {version.is_current
                  ? "Erneut veröffentlichen"
                  : "Veröffentlichen"}
              </Button>
            </Popconfirm>,
          ]}
        >
          <List.Item.Meta
            title={
              <Space wrap>
                <span>
                  Warnkarte vom {formatPriwaWarnkarteDate(version.source_date)}
                </span>
                {version.is_current && <Tag color="red">Aktiv</Tag>}
                {previewVersionId === version.id && (
                  <Tag color="gold">Vorschau</Tag>
                )}
              </Space>
            }
            description={
              <Typography.Text type="secondary">
                {version.feature_count} Polygone · importiert{" "}
                {new Date(version.imported_at).toLocaleString("de-DE")}
              </Typography.Text>
            }
          />
        </List.Item>
      )}
    />
  );
}
