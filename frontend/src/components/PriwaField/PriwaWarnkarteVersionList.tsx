import {
  Button,
  Empty,
  List,
  Popconfirm,
  Radio,
  Space,
  Tag,
  Typography,
} from "antd";

import type { IPriwaWarnkarteVersion } from "../../api/priwaWarnkarte";
import { formatPriwaWarnkarteDate } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteVersionListProps {
  versions: IPriwaWarnkarteVersion[];
  visibleVersionId: string | null;
  isBusy: boolean;
  onShowVersion: (versionId: string) => void;
  onPublish: (versionId: string) => void;
}

export default function PriwaWarnkarteVersionList({
  versions,
  visibleVersionId,
  isBusy,
  onShowVersion,
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
    <Radio.Group
      className="w-full"
      value={visibleVersionId}
      onChange={(event) => onShowVersion(event.target.value)}
    >
      <List
        className="w-full"
        dataSource={versions}
        renderItem={(version) => {
          const isVisible = visibleVersionId === version.id;
          return (
            <List.Item className="!block !px-0">
              <div
                className={`rounded-lg border p-3 ${
                  isVisible
                    ? "border-emerald-300 bg-emerald-50/70"
                    : "border-slate-200 bg-white"
                }`}
              >
                <Space wrap size={[6, 4]}>
                  <Typography.Text strong>
                    Warnkarte vom{" "}
                    {formatPriwaWarnkarteDate(version.source_date)}
                  </Typography.Text>
                  {version.is_current && <Tag color="red">Aktiv</Tag>}
                  {isVisible && <Tag color="green">Sichtbar</Tag>}
                </Space>
                <Typography.Paragraph
                  type="secondary"
                  className="!mb-3 !mt-1 text-xs"
                >
                  {version.feature_count} Polygone · importiert{" "}
                  {new Date(version.imported_at).toLocaleString("de-DE")}
                </Typography.Paragraph>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Radio value={version.id} disabled={isBusy}>
                    {isVisible ? "Auf Karte sichtbar" : "Auf Karte anzeigen"}
                  </Radio>
                  {!version.is_current && (
                    <Popconfirm
                      title="Diese Version als aktive Warnkarte veröffentlichen?"
                      description="Die bisherige Version bleibt erhalten und kann erneut veröffentlicht werden."
                      okText="Veröffentlichen"
                      cancelText="Abbrechen"
                      onConfirm={() => onPublish(version.id)}
                    >
                      <Button
                        size="small"
                        type="primary"
                        danger
                        disabled={isBusy}
                      >
                        Veröffentlichen
                      </Button>
                    </Popconfirm>
                  )}
                </div>
              </div>
            </List.Item>
          );
        }}
      />
    </Radio.Group>
  );
}
