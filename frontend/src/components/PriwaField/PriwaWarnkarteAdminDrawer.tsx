import { WarningOutlined } from "@ant-design/icons";
import { Alert, App, Button, Divider, Drawer, Spin, Typography } from "antd";
import { useState } from "react";

import type {
  IPriwaWarnkarteValidationSummary,
  IPriwaWarnkarteVersion,
} from "../../api/priwaWarnkarte";
import PriwaWarnkarteUploadPanel from "./PriwaWarnkarteUploadPanel";
import PriwaWarnkarteVersionList from "./PriwaWarnkarteVersionList";
import { formatPriwaWarnkarteError } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteAdminDrawerProps {
  versions: IPriwaWarnkarteVersion[];
  versionsError: unknown;
  isLoadingVersions: boolean;
  previewVersionId: string | null;
  onClearPreview: () => void;
  onValidate: (file: File) => Promise<IPriwaWarnkarteValidationSummary>;
  onImport: (file: File, confirmedDate: string) => Promise<unknown>;
  onPreview: (versionId: string) => Promise<void>;
  onPublish: (versionId: string) => Promise<void>;
}

export default function PriwaWarnkarteAdminDrawer({
  versions,
  versionsError,
  isLoadingVersions,
  previewVersionId,
  onClearPreview,
  onValidate,
  onImport,
  onPreview,
  onPublish,
}: PriwaWarnkarteAdminDrawerProps) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
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

  const validate = () => {
    if (!file) return;
    void run(async () => {
      setSummary(await onValidate(file));
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
    <>
      <Button
        className="absolute right-4 top-4 z-[70] shadow-md"
        icon={<WarningOutlined />}
        onClick={() => setOpen(true)}
      >
        Warnkarte verwalten
      </Button>
      <Drawer
        title="PRIWA Warnkarte verwalten"
        width={620}
        open={open}
        onClose={() => setOpen(false)}
        extra={
          previewVersionId ? (
            <Button onClick={onClearPreview}>Vorschau beenden</Button>
          ) : null
        }
      >
        <Typography.Title level={5}>Neue Version</Typography.Title>
        <PriwaWarnkarteUploadPanel
          file={file}
          summary={summary}
          isConfirmed={isConfirmed}
          isBusy={isBusy}
          errorMessage={errorMessage}
          onFileChange={(nextFile) => {
            setFile(nextFile);
            setSummary(null);
            setConfirmed(false);
            setErrorMessage(null);
          }}
          onConfirmedChange={setConfirmed}
          onValidate={validate}
          onImport={importFile}
        />
        <Divider />
        <Typography.Title level={5}>Importierte Versionen</Typography.Title>
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
      </Drawer>
    </>
  );
}
