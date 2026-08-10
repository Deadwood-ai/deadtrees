import { InboxOutlined, UndoOutlined } from "@ant-design/icons";
import {
  Button,
  Collapse,
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
  onArchive: (versionId: string) => void;
  onRestore: (versionId: string) => void;
}

const versionTitle = (version: IPriwaWarnkarteVersion) => (
  <Typography.Text strong>
    Warnkarte vom {formatPriwaWarnkarteDate(version.source_date)}
  </Typography.Text>
);

const versionMetadata = (version: IPriwaWarnkarteVersion) => (
  <Typography.Paragraph type="secondary" className="!mb-3 !mt-1 text-xs">
    {version.feature_count} Polygone · importiert{" "}
    {new Date(version.imported_at).toLocaleString("de-DE")}
  </Typography.Paragraph>
);

export default function PriwaWarnkarteVersionList({
  versions,
  visibleVersionId,
  isBusy,
  onShowVersion,
  onPublish,
  onArchive,
  onRestore,
}: PriwaWarnkarteVersionListProps) {
  const availableVersions = versions.filter((version) => !version.is_archived);
  const archivedVersions = versions.filter((version) => version.is_archived);

  if (versions.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Noch keine Warnkarten importiert"
      />
    );
  }

  return (
    <div className="space-y-3">
      {availableVersions.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Keine verfügbaren Warnkarten"
        />
      ) : (
        <Radio.Group
          className="w-full"
          value={visibleVersionId}
          onChange={(event) => onShowVersion(event.target.value)}
        >
          <List
            className="w-full"
            dataSource={availableVersions}
            renderItem={(version) => {
              const isVisible = visibleVersionId === version.id;
              return (
                <List.Item
                  className="!block !px-0"
                  data-testid={`priwa-warnkarte-version-${version.id}`}
                >
                  <div
                    className={`rounded-lg border p-3 ${
                      isVisible
                        ? "border-emerald-300 bg-emerald-50/70"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <Space wrap size={[6, 4]}>
                      {versionTitle(version)}
                      {version.is_current && <Tag color="red">Aktiv</Tag>}
                      {isVisible && <Tag color="green">Sichtbar</Tag>}
                    </Space>
                    {versionMetadata(version)}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Radio value={version.id} disabled={isBusy}>
                        {isVisible
                          ? "Auf Karte sichtbar"
                          : "Auf Karte anzeigen"}
                      </Radio>
                      {!version.is_current && (
                        <Space wrap size="small">
                          <Popconfirm
                            title="Diese Version archivieren?"
                            description="Sie wird ausgeblendet, bleibt aber vollständig erhalten und kann wiederhergestellt werden."
                            okText="Archivieren"
                            cancelText="Abbrechen"
                            onConfirm={() => onArchive(version.id)}
                          >
                            <Button
                              size="small"
                              icon={<InboxOutlined />}
                              disabled={isBusy}
                            >
                              Archivieren
                            </Button>
                          </Popconfirm>
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
                        </Space>
                      )}
                    </div>
                  </div>
                </List.Item>
              );
            }}
          />
        </Radio.Group>
      )}

      {archivedVersions.length > 0 && (
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: "archived",
              label: `Archiviert (${archivedVersions.length})`,
              children: (
                <List
                  dataSource={archivedVersions}
                  renderItem={(version) => (
                    <List.Item
                      className="!block !px-0"
                      data-testid={`priwa-warnkarte-archived-${version.id}`}
                    >
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        {versionTitle(version)}
                        {versionMetadata(version)}
                        <Button
                          size="small"
                          icon={<UndoOutlined />}
                          disabled={isBusy}
                          onClick={() => onRestore(version.id)}
                        >
                          Wiederherstellen
                        </Button>
                      </div>
                    </List.Item>
                  )}
                />
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
