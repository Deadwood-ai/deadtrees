import { DeleteOutlined, SaveOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo } from "react";

import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeSaveInput,
  IPriwaPoint,
  PriwaBefallsgruppeOrigin,
} from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

export interface IPriwaBefallsgruppeEditorDraft {
  id?: string;
  name: string;
  origin: PriwaBefallsgruppeOrigin;
  confidence?: number | null;
  suggestionReason?: string | null;
  algorithmVersion?: string | null;
  treeIds: string[];
  datasetIds: string[];
}

interface IPriwaBefallsgruppeEditorValues {
  name: string;
  treeIds: string[];
  datasetIds: string[];
}

interface PriwaBefallsgruppeEditorProps {
  open: boolean;
  isMobile: boolean;
  draft: IPriwaBefallsgruppeEditorDraft | null;
  points: IPriwaPoint[];
  mosaics: IPriwaMosaic[];
  groups: IPriwaBefallsgruppe[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (input: IPriwaBefallsgruppeSaveInput) => Promise<void>;
  onDelete: (groupId: string) => Promise<void>;
}

const formatDate = (value: string | null) => {
  const match = value && /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "ohne Datum";
};

export default function PriwaBefallsgruppeEditor({
  open,
  isMobile,
  draft,
  points,
  mosaics,
  groups,
  isSaving,
  onClose,
  onSave,
  onDelete,
}: PriwaBefallsgruppeEditorProps) {
  const [form] = Form.useForm<IPriwaBefallsgruppeEditorValues>();
  const selectedTreeIds = Form.useWatch("treeIds", form);
  const groupByTreeId = useMemo(() => {
    const index = new Map<string, IPriwaBefallsgruppe>();
    groups.forEach((group) =>
      group.treeIds.forEach((treeId) => index.set(treeId, group)),
    );
    return index;
  }, [groups]);
  const movedGroups = useMemo(
    () =>
      Array.from(
        new Set(
          (selectedTreeIds ?? [])
            .map((treeId) => groupByTreeId.get(treeId))
            .filter(
              (group): group is IPriwaBefallsgruppe =>
                !!group && group.id !== draft?.id,
            )
            .map((group) => group.name),
        ),
      ),
    [draft?.id, groupByTreeId, selectedTreeIds],
  );

  useEffect(() => {
    if (!open || !draft) return;
    form.setFieldsValue({
      name: draft.name,
      treeIds: draft.treeIds,
      datasetIds: draft.datasetIds,
    });
  }, [draft, form, open]);

  const submit = async (values: IPriwaBefallsgruppeEditorValues) => {
    if (!draft) return;
    await onSave({
      id: draft.id,
      name: values.name.trim(),
      origin: draft.origin,
      confidence: draft.confidence,
      suggestionReason: draft.suggestionReason,
      algorithmVersion: draft.algorithmVersion,
      treeIds: values.treeIds,
      datasetIds: values.datasetIds ?? [],
    });
  };

  return (
    <Drawer
      title={draft?.id ? "Befallsgruppe bearbeiten" : "Befallsgruppe anlegen"}
      open={open}
      onClose={onClose}
      placement={isMobile ? "bottom" : "right"}
      width={isMobile ? undefined : 480}
      height={isMobile ? "88dvh" : undefined}
      mask={false}
      destroyOnClose
      styles={{
        body: {
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)",
        },
      }}
    >
      {draft && (
        <Form form={form} layout="vertical" onFinish={submit}>
          {draft.suggestionReason && (
            <Alert
              className="mb-4"
              type="info"
              showIcon
              message="Automatischer Vorschlag"
              description={draft.suggestionReason}
            />
          )}

          {movedGroups.length > 0 && (
            <Alert
              className="mb-4"
              type="warning"
              showIcon
              message="Bäume werden verschoben"
              description={`Aus ${movedGroups.join(", ")} ausgewählte Bäume werden dieser Gruppe zugeordnet. Leere Gruppen werden entfernt.`}
            />
          )}

          <Form.Item
            label="Name"
            name="name"
            rules={[
              { required: true, whitespace: true, message: "Name eingeben" },
            ]}
          >
            <Input maxLength={80} />
          </Form.Item>

          <Typography.Title level={5}>Käferbäume</Typography.Title>
          <Typography.Paragraph type="secondary" className="!mb-2 !text-xs">
            Bäume können entfernt, ergänzt oder aus einer anderen Gruppe
            übernommen werden.
          </Typography.Paragraph>
          <Form.Item
            name="treeIds"
            rules={[
              {
                validator: (_, value: string[]) =>
                  value?.length
                    ? Promise.resolve()
                    : Promise.reject(
                        new Error("Mindestens einen Baum auswählen"),
                      ),
              },
            ]}
          >
            <Checkbox.Group className="w-full">
              <div className="max-h-64 space-y-1 overflow-y-auto rounded border border-slate-200 p-2">
                {points.map((point) => {
                  const existingGroup = groupByTreeId.get(point.id);
                  return (
                    <label
                      key={point.id}
                      className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-50"
                    >
                      <Checkbox value={point.id} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {point.baumnr
                            ? `Baum ${point.baumnr}`
                            : "Ohne Baumnr"}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {point.baumart} · {formatDate(point.datum)}
                        </span>
                      </span>
                      {existingGroup && existingGroup.id !== draft.id && (
                        <Tag className="m-0 shrink-0" color="gold">
                          {existingGroup.name}
                        </Tag>
                      )}
                    </label>
                  );
                })}
              </div>
            </Checkbox.Group>
          </Form.Item>

          <Typography.Title level={5}>Umfeldbefliegungen</Typography.Title>
          <Typography.Paragraph type="secondary" className="!mb-2 !text-xs">
            Nur hier bestätigte Befliegungen werden für die gespeicherte Gruppe
            angezeigt. Eine leere Auswahl ist eine bewusste Zuordnung ohne Flug.
          </Typography.Paragraph>
          <Form.Item name="datasetIds">
            <Checkbox.Group className="w-full">
              <div className="max-h-56 space-y-1 overflow-y-auto rounded border border-slate-200 p-2">
                {mosaics.map((mosaic) => (
                  <label
                    key={mosaic.id}
                    className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-50"
                  >
                    <Checkbox value={mosaic.id} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {mosaic.label}
                      </span>
                      <span className="block text-xs text-slate-500">
                        Aufnahme {formatDate(mosaic.captureDate)}
                      </span>
                    </span>
                  </label>
                ))}
                {mosaics.length === 0 && (
                  <div className="px-2 py-4 text-center text-xs text-slate-500">
                    Keine Umfeldbefliegungen verfügbar
                  </div>
                )}
              </div>
            </Checkbox.Group>
          </Form.Item>

          <div className="mt-5 flex gap-2">
            {draft.id && (
              <Popconfirm
                title="Befallsgruppe löschen?"
                description="Die Bäume werden wieder für neue Vorschläge freigegeben."
                okText="Löschen"
                cancelText="Abbrechen"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDelete(draft.id as string)}
              >
                <Button danger icon={<DeleteOutlined />} loading={isSaving}>
                  Löschen
                </Button>
              </Popconfirm>
            )}
            <Button
              className="ml-auto"
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={isSaving}
            >
              Gruppe speichern
            </Button>
          </div>
        </Form>
      )}
    </Drawer>
  );
}
