import { CloseOutlined } from "@ant-design/icons";
import { Alert, App, Button, Divider, Spin, Typography } from "antd";
import { useState } from "react";

import type {
  IPriwaWarnkarteValidationSummary,
  IPriwaWarnkarteVersion,
} from "../../api/priwaWarnkarte";
import PriwaWarnkarteUploadPanel from "./PriwaWarnkarteUploadPanel";
import PriwaWarnkarteVersionList from "./PriwaWarnkarteVersionList";
import { formatPriwaWarnkarteError } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteAdminPanelProps {
  versions: IPriwaWarnkarteVersion[];
  versionsError: unknown;
  isLoadingVersions: boolean;
  previewVersionId: string | null;
  onClose: () => void;
  onClearPreview: () => void;
  onValidate: (file: File) => Promise<IPriwaWarnkarteValidationSummary>;
  onImport: (file: File, confirmedDate: string) => Promise<unknown>;
  onPreview: (versionId: string) => Promise<void>;
  onPublish: (versionId: string) => Promise<void>;
}

export default function PriwaWarnkarteAdminPanel({
  versions,
  versionsError,
  isLoadingVersions,
  previewVersionId,
  onClose,
  onClearPreview,
  onValidate,
  onImport,
  onPreview,
  onPublish,
}: PriwaWarnkarteAdminPanelProps) {
  const { message } = App.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] =
    useState<IPriwaWarnkarteValidationSummary | null>(null);
  const [isConfirmed, setConfirmed] = useState(false);
  const [isBusy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setErrorMessage(null);
    try {
      await operation();
    } catch (error) {
      setErrorMessage(formatPriwaWarnkarteError(error));
    } finally {
      setBusy(false);
    }
  };

  const selectFile = (nextFile: File | null) => {
    setFile(nextFile);
    setSummary(null);
    setConfirmed(false);
    setErrorMessage(null);
    if (!nextFile) return;

    void run(async () => {
      setSummary(await onValidate(nextFile));
      setConfirmed(false);
    });
  };

  const importFile = () => {
    if (!file || !summary || !isConfirmed) return;
    void run(async () => {
      await onImport(file, summary.authoritative_date);
      message.success(
        "Warnkarte unveröffentlicht importiert. Die Vorschau ist aktiv.",
      );
    });
  };

  const preview = (versionId: string) =>
    void run(async () => {
      await onPreview(versionId);
      message.success("Warnkarten-Vorschau geladen.");
    });

  const publish = (versionId: string) =>
    void run(async () => {
      await onPublish(versionId);
      message.success("Warnkarte veröffentlicht.");
    });

  return (
    <div data-testid="priwa-warnkarte-admin-panel">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <Typography.Title level={4} className="!mb-1">
            PRIWA Warnkarte verwalten
          </Typography.Title>
          <Typography.Text type="secondary" className="text-xs">
            Die Karte bleibt während der Verwaltung bedienbar.
          </Typography.Text>
        </div>
        <Button
          type="text"
          icon={<CloseOutlined />}
          aria-label="Warnkarten-Verwaltung schließen"
          onClick={onClose}
        />
      </header>

      {previewVersionId && (
        <Button className="mb-4" block onClick={onClearPreview}>
          Vorschau beenden
        </Button>
      )}

      <Typography.Title level={5}>Neue Version</Typography.Title>
      <PriwaWarnkarteUploadPanel
        summary={summary}
        isConfirmed={isConfirmed}
        isBusy={isBusy}
        errorMessage={errorMessage}
        onFileChange={selectFile}
        onConfirmedChange={setConfirmed}
        onImport={importFile}
      />
      <Divider />
      <Typography.Title level={5}>Importierte Versionen</Typography.Title>
      <Typography.Paragraph type="secondary" className="!mt-0 text-xs">
        Es ist immer genau eine Version aktiv. Frühere Versionen bleiben
        erhalten und können erneut veröffentlicht werden.
      </Typography.Paragraph>
      {!!versionsError && (
        <Alert
          type="error"
          showIcon
          message="Versionen konnten nicht geladen werden"
          description={formatPriwaWarnkarteError(versionsError)}
        />
      )}
      {isLoadingVersions ? (
        <div className="flex justify-center p-8">
          <Spin />
        </div>
      ) : (
        <PriwaWarnkarteVersionList
          versions={versions}
          previewVersionId={previewVersionId}
          isBusy={isBusy}
          onPreview={preview}
          onPublish={publish}
        />
      )}
    </div>
  );
}
