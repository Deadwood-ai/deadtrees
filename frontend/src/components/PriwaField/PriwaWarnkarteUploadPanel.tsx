import { UploadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Space,
  Typography,
  Upload,
} from "antd";

import type { IPriwaWarnkarteValidationSummary } from "../../api/priwaWarnkarte";
import { formatPriwaWarnkarteDate } from "./priwaWarnkartePresentation";

interface PriwaWarnkarteUploadPanelProps {
  file: File | null;
  summary: IPriwaWarnkarteValidationSummary | null;
  isConfirmed: boolean;
  isBusy: boolean;
  errorMessage: string | null;
  onFileChange: (file: File | null) => void;
  onConfirmedChange: (confirmed: boolean) => void;
  onValidate: () => void;
  onImport: () => void;
}

export default function PriwaWarnkarteUploadPanel({
  file,
  summary,
  isConfirmed,
  isBusy,
  errorMessage,
  onFileChange,
  onConfirmedChange,
  onValidate,
  onImport,
}: PriwaWarnkarteUploadPanelProps) {
  return (
    <Space direction="vertical" size="middle" className="w-full">
      <Typography.Paragraph type="secondary" className="mb-0">
        Nur direkte GeoPackages mit genau einem Polygon-Layer und EPSG:32632.
        ZIP und GeoJSON werden nicht akzeptiert.
      </Typography.Paragraph>
      <Upload
        accept=".gpkg"
        disabled={isBusy}
        maxCount={1}
        beforeUpload={(nextFile) => {
          onFileChange(nextFile);
          return false;
        }}
        onRemove={() => {
          onFileChange(null);
          return true;
        }}
      >
        <Button icon={<UploadOutlined />}>GeoPackage auswählen</Button>
      </Upload>
      <Button
        type="primary"
        disabled={!file || isBusy}
        loading={isBusy && !summary}
        onClick={onValidate}
      >
        Datei validieren
      </Button>

      {errorMessage && (
        <Alert
          type="error"
          showIcon
          message="Validierung fehlgeschlagen"
          description={errorMessage}
        />
      )}

      {summary && (
        <>
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="Maßgebliches Datum">
              {formatPriwaWarnkarteDate(summary.authoritative_date)}
            </Descriptions.Item>
            <Descriptions.Item label="Polygone">
              {summary.feature_count}
            </Descriptions.Item>
            <Descriptions.Item label="Layer">{summary.layer}</Descriptions.Item>
            <Descriptions.Item label="CRS">{summary.crs}</Descriptions.Item>
            <Descriptions.Item label="Prüfsumme">
              <Typography.Text copyable ellipsis className="max-w-64">
                {summary.checksum_sha256}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          {summary.warnings.map((warning) => (
            <Alert
              key={warning.code}
              type="warning"
              showIcon
              message={warning.message}
            />
          ))}
          <Checkbox
            checked={isConfirmed}
            onChange={(event) => onConfirmedChange(event.target.checked)}
          >
            Ich bestätige das maßgebliche Datum{" "}
            {formatPriwaWarnkarteDate(summary.authoritative_date)} aus dem
            Dateinamen.
          </Checkbox>
          <Button
            type="primary"
            danger
            disabled={!isConfirmed || isBusy}
            loading={isBusy}
            onClick={onImport}
          >
            Unveröffentlicht importieren und Vorschau öffnen
          </Button>
        </>
      )}
    </Space>
  );
}
