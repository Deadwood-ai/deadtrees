import {
  Alert,
  Button,
  Collapse,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Typography,
  message,
} from "antd";
import {
  AimOutlined,
  CheckCircleFilled,
  DownOutlined,
  EnvironmentOutlined,
  QrcodeOutlined,
  SaveOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";

import { parseGoogleMapsCoordinates } from "./parseGoogleMapsCoordinates";
import QrCoordinateScanner from "./QrCoordinateScanner";
import type {
  IPriwaCoordinate,
  IPriwaPoint,
  PriwaBaumart,
  PriwaBohrloch,
  PriwaCoordinateSource,
  PriwaFund,
  PriwaHarz,
  PriwaNadel,
  PriwaObserverName,
  PriwaPercentClass,
  PriwaYesNo,
} from "./types";

const today = () => new Date().toISOString().slice(0, 10);

const observerOptions: Array<{ label: string; value: PriwaObserverName }> = [
  { label: "Sigi Huber", value: "Sigi Huber" },
  { label: "Martin Schade", value: "Martin Schade" },
  { label: "Maurice Mayer", value: "Maurice Mayer" },
  { label: "Lukas Ruf", value: "Lukas Ruf" },
  { label: "Markus Mayer", value: "Markus Mayer" },
  { label: "Andere", value: "andere" },
];

const fundOptions: Array<{ label: string; value: PriwaFund }> = [
  { label: "Ja", value: "ja" },
  { label: "Ja, kein Buchdrucker", value: "ja_kein_buchdrucker" },
  { label: "Nein", value: "nein" },
  { label: "Unsicher", value: "unsicher" },
];

const baumartOptions: Array<{ label: string; value: PriwaBaumart }> = [
  { label: "Fichte", value: "Fichte" },
  { label: "Tanne", value: "Tanne" },
  { label: "Douglasie", value: "Douglasie" },
  { label: "Lärche", value: "Lärche" },
  { label: "Kiefer", value: "Kiefer" },
  { label: "Anderes Nadelholz", value: "anderes Nadelholz" },
  { label: "Laubholz", value: "Laubholz" },
];

const yesNoOptions: Array<{ label: string; value: PriwaYesNo }> = [
  { label: "Ja", value: "ja" },
  { label: "Nein", value: "nein" },
];

const bohrlochOptions: Array<{ label: string; value: PriwaBohrloch }> = [
  { label: "Ja", value: "ja" },
  { label: "Nein", value: "nein" },
  { label: "Ja, kein Buchdrucker", value: "ja_kein_buchdrucker" },
];

const harzOptions: Array<{ label: string; value: PriwaHarz }> = [
  { label: "Vereinzelte Harztropfen", value: "vereinzelte Harztropfen" },
  {
    label: "Mittlerer/flächiger Harzfluss",
    value: "mittlerer/flächiger Harzfluss",
  },
  { label: "Nein", value: "nein" },
];

const nadelOptions: Array<{ label: string; value: PriwaNadel }> = [
  { label: "Grün", value: "grün" },
  { label: "Fahlgrün/gelblich", value: "fahlgrün/gelblich" },
  { label: "Rot/braun", value: "rot/braun" },
  { label: "Abgefallen", value: "abgefallen" },
];

const percentOptions: Array<{ label: string; value: PriwaPercentClass }> = [
  { label: "0%", value: "0%" },
  { label: "Bis 25%", value: "bis25%" },
  { label: "Bis 50%", value: "bis50%" },
  { label: ">50%", value: ">50%" },
];

interface IPriwaPointFormValues {
  baumnr: string;
  fund: PriwaFund;
  baumart: PriwaBaumart;
  bm: PriwaYesNo;
  bohrloch: PriwaBohrloch;
  harz: PriwaHarz;
  nadel: PriwaNadel;
  rinde: PriwaPercentClass;
  kv: PriwaPercentClass;
  name: PriwaObserverName;
  datum: string;
  kom: string;
}

const createDefaultFormValues = (): IPriwaPointFormValues => ({
  baumnr: "",
  fund: "ja",
  baumart: "Fichte",
  bm: "nein",
  bohrloch: "nein",
  harz: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "andere",
  datum: today(),
  kom: "",
});

const createFormValuesFromPoint = (
  point: IPriwaPoint,
): IPriwaPointFormValues => ({
  baumnr: point.baumnr,
  fund: point.fund,
  baumart: point.baumart,
  bm: point.bm,
  bohrloch: point.bohrloch,
  harz: point.harz,
  nadel: point.nadel,
  rinde: point.rinde,
  kv: point.kv,
  name: point.name,
  datum: point.datum,
  kom: point.kom,
});

interface PriwaPointDrawerProps {
  open: boolean;
  formSessionId: number;
  editingPoint: IPriwaPoint | null;
  selectedCoordinate: IPriwaCoordinate | null;
  selectedCoordinateSource: PriwaCoordinateSource;
  currentUserCoordinate: IPriwaCoordinate | null;
  onClose: () => void;
  onAddPoint: (point: IPriwaPoint) => Promise<void>;
  onUpdatePoint: (point: IPriwaPoint) => Promise<void>;
  onDeletePoint: (pointId: string) => Promise<void>;
  isSaving?: boolean;
  onRequestMapPlacement: () => void;
  onPreviewCoordinate: (coordinate: IPriwaCoordinate | null) => void;
  onZoomToPoint: (coordinate: IPriwaCoordinate) => void;
}

export default function PriwaPointDrawer({
  open,
  formSessionId,
  editingPoint,
  selectedCoordinate,
  selectedCoordinateSource,
  currentUserCoordinate,
  onClose,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  isSaving = false,
  onRequestMapPlacement,
  onPreviewCoordinate,
  onZoomToPoint,
}: PriwaPointDrawerProps) {
  const [form] = Form.useForm<IPriwaPointFormValues>();
  const [rawQrValue, setRawQrValue] = useState("");
  const [coordinate, setCoordinate] = useState<IPriwaCoordinate | null>(null);
  const [coordinateSource, setCoordinateSource] =
    useState<PriwaCoordinateSource>("qr");
  const [isQrScannerOpen, setQrScannerOpen] = useState(false);

  const qrCoordinate = useMemo(
    () => parseGoogleMapsCoordinates(rawQrValue),
    [rawQrValue],
  );

  useEffect(() => {
    if (formSessionId === 0) return;

    if (editingPoint) {
      form.setFieldsValue(createFormValuesFromPoint(editingPoint));
      setRawQrValue(editingPoint.rawQrValue ?? "");
      return;
    }

    form.setFieldsValue(createDefaultFormValues());
    setRawQrValue("");
  }, [editingPoint, form, formSessionId]);

  useEffect(() => {
    if (!open) return;

    if (selectedCoordinate) {
      setCoordinate(selectedCoordinate);
      setCoordinateSource(selectedCoordinateSource);
      return;
    }

    if (editingPoint) {
      setCoordinate({ lat: editingPoint.lat, lon: editingPoint.lon });
      setCoordinateSource(editingPoint.coordinateSource);
      return;
    }

    setCoordinate(null);
    setCoordinateSource(selectedCoordinateSource);
  }, [editingPoint, open, selectedCoordinate, selectedCoordinateSource]);

  useEffect(() => {
    if (!open || !qrCoordinate) return;

    setCoordinate(qrCoordinate);
    setCoordinateSource("qr");
    setQrScannerOpen(false);
  }, [open, qrCoordinate]);

  useEffect(() => {
    onPreviewCoordinate(open ? coordinate : null);
  }, [coordinate, onPreviewCoordinate, open]);

  const useCurrentGpsCoordinate = () => {
    if (!currentUserCoordinate) return;

    setCoordinate(currentUserCoordinate);
    setCoordinateSource("gps");
  };

  const effectiveCoordinate = coordinate ?? currentUserCoordinate;
  const willUseEstimatedGps = !coordinate && !!currentUserCoordinate;
  const positionLabel = willUseEstimatedGps
    ? "GPS geschätzt"
    : coordinate
      ? coordinateSource === "qr"
        ? "QR"
        : coordinateSource === "map"
          ? "Karte"
          : "GPS"
      : "Keine Position";
  const positionDetail = effectiveCoordinate
    ? `${effectiveCoordinate.lat.toFixed(5)}, ${effectiveCoordinate.lon.toFixed(5)}`
    : "QR, GPS oder Karte";
  const hasConfirmedLocation = !!coordinate;
  const requiresBaumnr =
    willUseEstimatedGps || (hasConfirmedLocation && coordinateSource !== "qr");

  const handleSave = async () => {
    if (!effectiveCoordinate) return;

    try {
      const values = await form.validateFields();
      const savedCoordinateSource = willUseEstimatedGps
        ? "gps"
        : coordinateSource;
      const savedPoint: IPriwaPoint = {
        id: editingPoint?.id ?? crypto.randomUUID(),
        lat: effectiveCoordinate.lat,
        lon: effectiveCoordinate.lon,
        baumnr: values.baumnr?.trim() ?? "",
        fund: values.fund,
        baumart: values.baumart,
        bm: values.bm,
        bohrloch: values.bohrloch,
        harz: values.harz,
        nadel: values.nadel,
        rinde: values.rinde,
        kv: values.kv,
        name: values.name,
        datum: values.datum,
        kom: values.kom?.trim() ?? "",
        capturedAt: editingPoint?.capturedAt ?? new Date().toISOString(),
        coordinateSource: savedCoordinateSource,
        gps: willUseEstimatedGps ? "nein" : "ja",
        isEstimatedLocation: willUseEstimatedGps,
        rawQrValue:
          savedCoordinateSource === "qr" ? rawQrValue.trim() || undefined : undefined,
      };

      if (editingPoint) {
        await onUpdatePoint(savedPoint);
      } else {
        await onAddPoint(savedPoint);
      }

      onZoomToPoint(effectiveCoordinate);
      form.setFieldsValue(createDefaultFormValues());
      setRawQrValue("");
      setCoordinate(null);
      setCoordinateSource("qr");
      setQrScannerOpen(false);
      onClose();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : "Käferbaum konnte nicht gespeichert werden",
      );
    }
  };

  const handleDelete = () => {
    if (!editingPoint) return;

    Modal.confirm({
      title: "Käferbaum löschen?",
      content:
        "Der Eintrag wird nur ausgeblendet und kann später in der Datenbank wiederhergestellt werden.",
      okText: "Löschen",
      okButtonProps: { danger: true },
      cancelText: "Abbrechen",
      onOk: async () => {
        try {
          await onDeletePoint(editingPoint.id);
        } catch (error) {
          message.error(
            error instanceof Error
              ? error.message
              : "Käferbaum konnte nicht gelöscht werden",
          );
          throw error;
        }
      },
    });
  };

  return (
    <Drawer
      title={editingPoint ? "Käferbaum bearbeiten" : "Käferbaum aufnehmen"}
      open={open}
      onClose={onClose}
      placement="right"
      width="min(430px, 100vw)"
      rootClassName="priwa-point-drawer-root"
      className="priwa-point-drawer"
      destroyOnClose={false}
      styles={{
        body: { overflowX: "hidden", padding: "14px 18px 18px" },
        content: { maxWidth: "100vw", overflowX: "hidden" },
      }}
    >
      <div className="space-y-3">
        <section
          className={
            hasConfirmedLocation
              ? "rounded-md border border-emerald-500 bg-emerald-50 p-2.5 shadow-sm shadow-emerald-900/10"
              : "rounded-md border border-gray-200 bg-gray-50 p-2.5"
          }
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={
                  hasConfirmedLocation
                    ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
                    : "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-500"
                }
              >
                {hasConfirmedLocation ? (
                  <CheckCircleFilled />
                ) : (
                  <EnvironmentOutlined />
                )}
              </div>
              <div className="min-w-0">
                <Typography.Text
                  strong
                  className={
                    hasConfirmedLocation ? "text-emerald-900" : "text-gray-900"
                  }
                >
                  {hasConfirmedLocation ? "Position gesetzt" : positionLabel}
                </Typography.Text>
                <div
                  className={
                    hasConfirmedLocation
                      ? "truncate text-xs font-medium text-emerald-800"
                      : "truncate text-xs text-gray-500"
                  }
                >
                  {hasConfirmedLocation
                    ? `${positionLabel} · ${positionDetail}`
                    : positionDetail}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                className="h-11 w-12"
                style={{ height: 44, minWidth: 48, width: 48 }}
                icon={<QrcodeOutlined />}
                onClick={() => setQrScannerOpen(true)}
                aria-label="QR scannen"
              />
              <Button
                className="h-11 w-12"
                style={{ height: 44, minWidth: 48, width: 48 }}
                icon={<EnvironmentOutlined />}
                disabled={!currentUserCoordinate}
                onClick={useCurrentGpsCoordinate}
                aria-label="GPS übernehmen"
              />
              <Button
                className="h-11 w-12"
                style={{ height: 44, minWidth: 48, width: 48 }}
                icon={<AimOutlined />}
                onClick={onRequestMapPlacement}
                aria-label="Auf Karte setzen"
              />
            </div>
          </div>
          {willUseEstimatedGps && (
            <Alert
              className="mt-3"
              type="warning"
              showIcon
              message="Schnellspeichern nutzt GPS als geschätzte Lage."
            />
          )}
        </section>

        <Modal
          title="QR scannen"
          open={isQrScannerOpen}
          onCancel={() => setQrScannerOpen(false)}
          footer={null}
          destroyOnHidden
        >
          <QrCoordinateScanner autoStart onDetected={setRawQrValue} />
          <Form layout="vertical" className="mt-3">
            <Form.Item label="QR / Google Maps Link manuell">
              <Input.TextArea
                value={rawQrValue}
                onChange={(event) => setRawQrValue(event.target.value)}
                autoSize={{ minRows: 2, maxRows: 3 }}
                placeholder="https://www.google.com/maps/search/?api=1&query=48.456025,8.180315"
              />
            </Form.Item>
          </Form>
        </Modal>

        <Form
          layout="vertical"
          form={form}
          className="[&_.ant-form-item]:mb-2.5 [&_.ant-form-item-label]:pb-0.5 [&_.ant-form-item-label>label]:text-xs [&_.ant-form-item-label>label]:font-medium"
        >
          <Collapse
            ghost
            size="small"
            defaultActiveKey={editingPoint ? ["baum"] : []}
            expandIcon={({ isActive }) => (
              <DownOutlined rotate={isActive ? 180 : 0} />
            )}
            items={[
              {
                key: "baum",
                label: <Typography.Text strong>Baum</Typography.Text>,
                children: (
                  <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
                    <Form.Item
                      label="Baumnr"
                      name="baumnr"
                      rules={[
                        {
                          required: requiresBaumnr,
                          whitespace: true,
                          message:
                            "Baumnr ist für GPS- oder Kartenpositionen erforderlich",
                        },
                      ]}
                    >
                      <Input maxLength={20} placeholder="optional" />
                    </Form.Item>
                    <Form.Item label="Fund" name="fund">
                      <Select options={fundOptions} />
                    </Form.Item>
                    <Form.Item label="Name" name="name">
                      <Select options={observerOptions} />
                    </Form.Item>
                    <Form.Item label="Datum" name="datum">
                      <Input type="date" />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
            className="rounded-md border border-gray-200 bg-white [&_.ant-collapse-content-box]:pb-1 [&_.ant-collapse-content-box]:pt-0 [&_.ant-collapse-header]:px-0 [&_.ant-collapse-header]:py-1.5"
          />

          <section className="mt-3 space-y-2 border-t border-gray-200 pt-3">
            <Typography.Text strong>Befallssymptome</Typography.Text>
            <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
              <Form.Item label="Baumart" name="baumart">
                <Select options={baumartOptions} />
              </Form.Item>
              <Form.Item label="Bohrmehl" name="bm">
                <Select options={yesNoOptions} />
              </Form.Item>
              <Form.Item label="Bohrloch" name="bohrloch">
                <Select options={bohrlochOptions} />
              </Form.Item>
              <Form.Item label="Harzfluss" name="harz">
                <Select options={harzOptions} />
              </Form.Item>
              <Form.Item label="Nadelfarbe" name="nadel">
                <Select options={nadelOptions} />
              </Form.Item>
              <Form.Item label="Rindenverluste" name="rinde">
                <Select options={percentOptions} />
              </Form.Item>
              <Form.Item label="Kronenverluste" name="kv">
                <Select options={percentOptions} />
              </Form.Item>
            </div>
          </section>

          <section className="mt-3 space-y-2 border-t border-gray-200 pt-3">
            <Typography.Text strong>Optional</Typography.Text>
            <Form.Item
              label="Kommentar"
              name="kom"
              rules={[{ max: 200, message: "Maximal 200 Zeichen" }]}
            >
              <Input.TextArea
                maxLength={200}
                showCount
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            </Form.Item>
          </section>

          <Button
            className="mt-3"
            type="primary"
            icon={<SaveOutlined />}
            block
            disabled={!effectiveCoordinate}
            loading={isSaving}
            onClick={handleSave}
          >
            {editingPoint ? "Aktualisieren" : "Schnellspeichern"}
          </Button>
          {editingPoint && (
            <Button
              className="mt-2"
              danger
              icon={<DeleteOutlined />}
              block
              disabled={isSaving}
              onClick={handleDelete}
            >
              Löschen
            </Button>
          )}
        </Form>
      </div>
    </Drawer>
  );
}
