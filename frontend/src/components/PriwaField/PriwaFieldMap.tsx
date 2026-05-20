import {
  Alert,
  Button,
  FloatButton,
  Popover,
  Switch,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  AimOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  SlidersOutlined,
  SyncOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import "ol/ol.css";
import { Map } from "ol";
import { defaults as defaultInteractions } from "ol/interaction";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { unByKey } from "ol/Observable";
import { fromLonLat, toLonLat } from "ol/proj";
import View from "ol/View";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { createStandardMapControls } from "../../utils/basemaps";
import { useUserLocationLayer } from "../../hooks/useUserLocationLayer";
import { createLglDop20Layer } from "./createLglDop20Layer";
import { createPriwaCogLayer } from "./createPriwaCogLayer";
import {
  createPriwaPointFeature,
  createPriwaPointLayer,
  createPriwaPreviewFeature,
  createPriwaPreviewLayer,
} from "./createPriwaPointLayer";
import PriwaPointDrawer from "./PriwaPointDrawer";
import PriwaPointListPanel from "./PriwaPointListPanel";
import PriwaOfflineStatus from "./PriwaOfflineStatus";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import type {
  IPriwaCoordinate,
  IPriwaPoint,
  PriwaCoordinateSource,
} from "./types";

const FIELD_CENTER: [number, number] = [8.18013, 48.45596];

interface PriwaFieldMapProps {
  points: IPriwaPoint[];
  isLoadingPoints?: boolean;
  isSavingPoint?: boolean;
  projectName: string;
  cogPath?: string | null;
  isCogLoading?: boolean;
  errorMessage?: string | null;
  syncSummary?: IPriwaSyncSummary;
  onAddPoint: (point: IPriwaPoint) => Promise<void>;
  onUpdatePoint: (point: IPriwaPoint) => Promise<void>;
  onDeletePoint: (pointId: string) => Promise<void>;
  onSyncNow?: () => Promise<void>;
}

export default function PriwaFieldMap({
  points,
  isLoadingPoints = false,
  isSavingPoint = false,
  projectName,
  cogPath,
  isCogLoading = false,
  errorMessage = null,
  syncSummary,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  onSyncNow,
}: PriwaFieldMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const isPlacingPointRef = useRef(false);
  const hasRequestedOrientationFromInteractionRef = useRef(false);
  const pointLayerRef = useRef<ReturnType<typeof createPriwaPointLayer> | null>(
    null,
  );
  const previewLayerRef = useRef<ReturnType<
    typeof createPriwaPreviewLayer
  > | null>(null);
  const cogLayerRef = useRef<TileLayerWebGL | null>(null);
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [isCogVisible, setCogVisible] = useState(true);
  const [isPlacingPoint, setPlacingPoint] = useState(false);
  const [selectedCoordinate, setSelectedCoordinate] =
    useState<IPriwaCoordinate | null>(null);
  const [selectedCoordinateSource, setSelectedCoordinateSource] =
    useState<PriwaCoordinateSource>("qr");
  const [editingPoint, setEditingPoint] = useState<IPriwaPoint | null>(null);
  const [formSessionId, setFormSessionId] = useState(0);
  const [isPointListOpen, setPointListOpen] = useState(false);
  const userLocation = useUserLocationLayer(mapRef);
  const {
    layer: userLocationLayer,
    locateUser,
    stop: stopUserLocation,
  } = userLocation;

  const openPointForEditing = useCallback((point: IPriwaPoint) => {
    setPointListOpen(false);
    setFormSessionId((currentSessionId) => currentSessionId + 1);
    setEditingPoint(point);
    setSelectedCoordinate({ lat: point.lat, lon: point.lon });
    setSelectedCoordinateSource(point.coordinateSource);
    setDrawerOpen(true);
  }, []);

  useEffect(() => {
    isPlacingPointRef.current = isPlacingPoint;
    document.body.classList.toggle("priwa-placement-mode", isPlacingPoint);

    return () => {
      document.body.classList.remove("priwa-placement-mode");
    };
  }, [isPlacingPoint]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const dopLayer = createLglDop20Layer();
    const pointLayer = createPriwaPointLayer([]);
    const previewLayer = createPriwaPreviewLayer();
    pointLayerRef.current = pointLayer;
    previewLayerRef.current = previewLayer;

    const map = new Map({
      target: containerRef.current,
      layers: [dopLayer, pointLayer, previewLayer, userLocationLayer],
      view: new View({
        center: fromLonLat(FIELD_CENTER),
        zoom: 19,
        minZoom: 8,
        maxZoom: 21,
        projection: "EPSG:3857",
      }),
      interactions: defaultInteractions({
        pinchRotate: false,
        altShiftDragRotate: false,
      }),
      controls: createStandardMapControls({
        includeZoom: false,
        includeAttribution: true,
      }),
    });

    mapRef.current = map;

    const clickKey = map.on("singleclick", (event) => {
      if (isPlacingPointRef.current) return;

      const pointFeature = map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const point = feature.get("point") as IPriwaPoint | undefined;
          return point ?? null;
        },
        {
          hitTolerance: 18,
        },
      );

      if (pointFeature) {
        openPointForEditing(pointFeature);
      }
    });

    return () => {
      stopUserLocation();
      unByKey(clickKey);
      map.setTarget(undefined);
      mapRef.current = null;
      pointLayerRef.current = null;
      previewLayerRef.current = null;
      cogLayerRef.current = null;
    };
  }, [openPointForEditing, stopUserLocation, userLocationLayer]);

  useEffect(() => {
    const source = pointLayerRef.current?.getSource();
    if (!source) return;

    source.clear();
    points.forEach((point) =>
      source.addFeature(createPriwaPointFeature(point)),
    );
  }, [points]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (cogLayerRef.current) {
      map.removeLayer(cogLayerRef.current);
      cogLayerRef.current = null;
    }

    if (!cogPath || !isCogVisible) return;

    const cogLayer = createPriwaCogLayer(cogPath);
    cogLayerRef.current = cogLayer;
    map.getLayers().insertAt(1, cogLayer);
  }, [cogPath, isCogVisible]);

  const handlePreviewCoordinate = useCallback(
    (coordinate: IPriwaCoordinate | null) => {
      const source = previewLayerRef.current?.getSource();
      if (!source) return;

      source.clear();
      if (coordinate) {
        source.addFeature(createPriwaPreviewFeature(coordinate));
      }
    },
    [],
  );

  const zoomToCoordinate = useCallback((coordinate: IPriwaCoordinate) => {
    mapRef.current?.getView().animate({
      center: fromLonLat([coordinate.lon, coordinate.lat]),
      zoom: 20,
      duration: 500,
    });
  }, []);

  const openNewPointDrawer = useCallback(() => {
    setPointListOpen(false);
    setFormSessionId((currentSessionId) => currentSessionId + 1);
    setEditingPoint(null);
    setSelectedCoordinate(null);
    setSelectedCoordinateSource("qr");
    setDrawerOpen(true);
  }, []);

  const requestMapPlacement = useCallback(() => {
    setPointListOpen(false);
    setDrawerOpen(false);
    setPlacingPoint(true);
  }, []);

  const cancelMapPlacement = useCallback(() => {
    setPlacingPoint(false);
    setDrawerOpen(true);
  }, []);

  const acceptMapPlacement = useCallback(() => {
    const center = mapRef.current?.getView().getCenter();
    if (!center) return;

    const [lon, lat] = toLonLat(center);
    setSelectedCoordinate({ lat, lon });
    setSelectedCoordinateSource("map");
    setPlacingPoint(false);
    setDrawerOpen(true);
  }, []);

  const requestDeferredOrientationPermission = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!userLocation.needsOrientationPermission) return;
      if (
        event.target instanceof Element &&
        event.target.closest("button,[role='button']")
      )
        return;
      if (hasRequestedOrientationFromInteractionRef.current) return;

      hasRequestedOrientationFromInteractionRef.current = true;
      void locateUser(true);
    },
    [locateUser, userLocation.needsOrientationPermission],
  );

  const hasCenteredUserLocation =
    userLocation.isTracking &&
    userLocation.hasFix &&
    userLocation.hasZoomedToUser;
  const locationButtonActive =
    hasCenteredUserLocation &&
    !userLocation.needsOrientationPermission &&
    userLocation.isHeadingActive;
  const locationButtonTitle = userLocation.locationError
    ? "Standort erneut anfragen"
    : userLocation.needsOrientationPermission
      ? "Richtung aktivieren"
      : userLocation.isLocating
        ? "Standort wird gesucht"
        : "Aktuelle Position";
  const locationHintLabel = userLocation.locationError
    ? userLocation.locationError
    : userLocation.needsOrientationPermission
      ? "Richtung: Standort-Button antippen"
      : userLocation.isLocating
        ? "Standort wird angefragt"
        : locationButtonActive
          ? null
          : "Standort-Button antippen";
  const pointListToggleLabel = isPointListOpen
    ? "Punktliste schließen"
    : "Punktliste öffnen";

  const handleAddPoint = useCallback(
    async (point: IPriwaPoint) => {
      await onAddPoint(point);
      message.success("Käferbaum gespeichert");
    },
    [onAddPoint],
  );

  const handleUpdatePoint = useCallback(
    async (point: IPriwaPoint) => {
      await onUpdatePoint(point);
      message.success("Käferbaum aktualisiert");
    },
    [onUpdatePoint],
  );

  const handleDeletePoint = useCallback(
    async (pointId: string) => {
      await onDeletePoint(pointId);
      message.success("Käferbaum gelöscht");
      setDrawerOpen(false);
      setEditingPoint(null);
    },
    [onDeletePoint],
  );
  const hasPendingSync = (syncSummary?.total ?? 0) > 0;

  const layerPanel = (
    <div className="w-64 space-y-3">
      <div>
        <Typography.Text strong>Layer</Typography.Text>
        <div className="text-xs text-gray-500">
          PRIWA Punkte bleiben immer sichtbar.
        </div>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-gray-900">
            Drohnenlayer
          </div>
          <div className="text-xs text-gray-500">
            {isCogLoading
              ? "Lade Drohnenlayer..."
              : cogPath
                ? "Optionaler Overlay"
                : "Folgt in einem eigenen Schritt"}
          </div>
        </div>
        <Switch
          checked={isCogVisible}
          disabled={!cogPath}
          onChange={setCogVisible}
        />
      </div>
      <div className="border-t border-slate-200 pt-3">
        <Button
          block
          size="small"
          icon={<SyncOutlined spin={!!syncSummary?.syncing} />}
          disabled={!hasPendingSync || !onSyncNow}
          onClick={() => void onSyncNow?.()}
        >
          Jetzt synchronisieren
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className="relative h-full min-h-[100dvh] w-full overflow-hidden bg-neutral-950"
      onPointerDownCapture={requestDeferredOrientationPermission}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {!isPlacingPoint && (
        <>
          <div className="pointer-events-none absolute left-4 top-20 z-10 flex flex-col gap-2 md:top-24">
            <Tooltip title={locationButtonTitle}>
              <Button
                className={
                  userLocation.needsOrientationPermission
                    ? "pointer-events-auto border-amber-500 text-amber-700 shadow-md"
                    : "pointer-events-auto shadow-md"
                }
                type={locationButtonActive ? "primary" : "default"}
                shape="circle"
                size="large"
                icon={
                  userLocation.isLocating ? (
                    <AimOutlined spin />
                  ) : (
                    <EnvironmentOutlined />
                  )
                }
                onClick={() => userLocation.locateUser(true)}
                aria-label="Aktuelle Position aktivieren"
              />
            </Tooltip>
            <Popover trigger="click" placement="rightTop" content={layerPanel}>
              <Button
                className="pointer-events-auto shadow-md"
                shape="circle"
                size="large"
                icon={<SlidersOutlined />}
                aria-label="Layer auswählen"
              />
            </Popover>
            <Tooltip title={pointListToggleLabel}>
              <Button
                className="pointer-events-auto shadow-md"
                type={isPointListOpen ? "primary" : "default"}
                shape="circle"
                size="large"
                icon={<UnorderedListOutlined />}
                aria-pressed={isPointListOpen}
                onClick={() =>
                  setPointListOpen((currentIsOpen) => !currentIsOpen)
                }
                aria-label={pointListToggleLabel}
              />
            </Tooltip>
          </div>

          {!isPointListOpen && !isDrawerOpen && (
            <FloatButton
              className="priwa-add-point-fab"
              type="primary"
              shape="circle"
              icon={<PlusOutlined />}
              tooltip={{ title: "Punkt aufnehmen", placement: "left" }}
              onClick={openNewPointDrawer}
              aria-label="Punkt aufnehmen"
              style={{
                right: "max(20px, calc(env(safe-area-inset-right, 0px) + 20px))",
                bottom:
                  "max(20px, calc(env(safe-area-inset-bottom, 0px) + 20px))",
              }}
            />
          )}
        </>
      )}

      {isPointListOpen && !isPlacingPoint && (
        <PriwaPointListPanel
          points={points}
          projectName={projectName}
          isLoading={isLoadingPoints}
          onClose={() => setPointListOpen(false)}
          onEditPoint={openPointForEditing}
          onZoomToPoint={zoomToCoordinate}
        />
      )}

      {isPlacingPoint && (
        <div className="pointer-events-none absolute inset-0 z-[70]">
          <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2">
            <div className="absolute left-1/2 top-0 h-12 border-l-2 border-white drop-shadow" />
            <div className="absolute left-0 top-1/2 w-12 border-t-2 border-white drop-shadow" />
            <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-600 bg-white/80" />
          </div>
          <div className="pointer-events-auto absolute bottom-4 left-4 right-4 flex gap-2 rounded-md bg-white/95 p-2 shadow-lg backdrop-blur md:bottom-5">
            <Button block onClick={cancelMapPlacement}>
              Abbrechen
            </Button>
            <Button block type="primary" onClick={acceptMapPlacement}>
              Punkt übernehmen
            </Button>
          </div>
        </div>
      )}

      {!isPlacingPoint && (
        <div className="pointer-events-none absolute right-4 top-20 z-10 flex max-w-[calc(100%-5.75rem)] flex-col items-end gap-1.5 md:top-24">
          {locationHintLabel && (
            <div className="rounded-md bg-white/90 px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm backdrop-blur">
              {locationHintLabel}
            </div>
          )}
          <PriwaOfflineStatus syncSummary={syncSummary} />
        </div>
      )}

      {errorMessage && !isPlacingPoint && (
        <Alert
          className="absolute bottom-20 left-4 right-4 z-[55] shadow-lg md:left-auto md:w-96"
          type="error"
          showIcon
          message="PRIWA Daten konnten nicht geladen werden"
          description={errorMessage}
        />
      )}

      <PriwaPointDrawer
        open={isDrawerOpen}
        formSessionId={formSessionId}
        editingPoint={editingPoint}
        selectedCoordinate={selectedCoordinate}
        selectedCoordinateSource={selectedCoordinateSource}
        currentUserCoordinate={userLocation.currentCoordinate}
        onClose={() => {
          setDrawerOpen(false);
          setEditingPoint(null);
        }}
        onAddPoint={handleAddPoint}
        onUpdatePoint={handleUpdatePoint}
        onDeletePoint={handleDeletePoint}
        isSaving={isSavingPoint}
        onRequestMapPlacement={requestMapPlacement}
        onPreviewCoordinate={handlePreviewCoordinate}
        onZoomToPoint={zoomToCoordinate}
      />
    </div>
  );
}
