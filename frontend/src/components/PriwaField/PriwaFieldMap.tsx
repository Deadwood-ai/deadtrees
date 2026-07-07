import {
  Alert,
  Button,
  FloatButton,
  Popover,
  Progress,
  Segmented,
  Switch,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  AimOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import "ol/ol.css";
import { Map } from "ol";
import { defaults as defaultInteractions } from "ol/interaction";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { unByKey } from "ol/Observable";
import { fromLonLat, toLonLat } from "ol/proj";
import View from "ol/View";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { createStandardMapControls } from "../../utils/basemaps";
import { useUserLocationLayer } from "../../hooks/useUserLocationLayer";
import { createLglDop20Layer } from "./createLglDop20Layer";
import { createPriwaTopographicLayer } from "./createPriwaTopographicLayer";
import {
  createPriwaOfflineAreaFeature,
  createPriwaOfflineAreaLayer,
} from "./createPriwaOfflineAreaLayer";
import { createPriwaCogLayers } from "./createPriwaCogLayer";
import {
  createPriwaPointFeature,
  createPriwaPointLayer,
  createPriwaPreviewFeature,
  createPriwaPreviewLayer,
} from "./createPriwaPointLayer";
import PriwaPointDrawer from "./PriwaPointDrawer";
import PriwaPointListPanel from "./PriwaPointListPanel";
import PriwaOfflineStatus from "./PriwaOfflineStatus";
import { usePriwaOfflineBasemap } from "./usePriwaOfflineBasemap";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import type {
  IPriwaCoordinate,
  IPriwaPoint,
  PriwaCoordinateSource,
} from "./types";

const FIELD_CENTER: [number, number] = [8.18013, 48.45596];
type PriwaBaseLayer = "aerial" | "topographic";

const formatPriwaMosaicDate = (value: string | null | undefined) => {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) {
    return `${match[3]}.${match[2]}.${match[1]}`;
  }

  return value;
};

const mosaicDateRank = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
};

const mosaicIdRank = (id: string) => {
  const numericId = Number(id);
  return Number.isFinite(numericId) ? numericId : Number.NEGATIVE_INFINITY;
};

const comparePriwaMosaics = (left: IPriwaMosaic, right: IPriwaMosaic) => {
  const captureDifference =
    mosaicDateRank(right.captureDate) - mosaicDateRank(left.captureDate);
  if (captureDifference !== 0) return captureDifference;

  const uploadDifference =
    mosaicDateRank(right.createdAt) - mosaicDateRank(left.createdAt);
  if (uploadDifference !== 0) return uploadDifference;

  const idDifference = mosaicIdRank(right.id) - mosaicIdRank(left.id);
  if (idDifference !== 0) return idDifference;

  return right.id.localeCompare(left.id);
};

function MapLayersIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
    >
      <path d="M9 18.5 3.5 16V5.5L9 8v10.5Z" />
      <path d="m9 8 6-2.5 5.5 2.5v10.5L15 16l-6 2.5" />
      <path d="M15 5.5V16" />
      <path d="M6.2 10.2 9 11.5l3-1.25 3 1.25 2.8-1.2" opacity={0.55} />
    </svg>
  );
}

interface PriwaFieldMapProps {
  points: IPriwaPoint[];
  projectId: string;
  isLoadingPoints?: boolean;
  isSavingPoint?: boolean;
  projectName: string;
  mosaics?: IPriwaMosaic[];
  isCogLoading?: boolean;
  cogErrorMessage?: string | null;
  errorMessage?: string | null;
  syncSummary?: IPriwaSyncSummary;
  onAddPoint: (point: IPriwaPoint) => Promise<void>;
  onUpdatePoint: (point: IPriwaPoint) => Promise<void>;
  onDeletePoint: (pointId: string) => Promise<void>;
  onSyncNow?: () => Promise<void>;
}

export default function PriwaFieldMap({
  points,
  projectId,
  isLoadingPoints = false,
  isSavingPoint = false,
  projectName,
  mosaics = [],
  isCogLoading = false,
  cogErrorMessage = null,
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
  const offlineAreaLayerRef = useRef<ReturnType<
    typeof createPriwaOfflineAreaLayer
  > | null>(null);
  const aerialLayerRef = useRef<ReturnType<typeof createLglDop20Layer> | null>(
    null,
  );
  const topographicLayerRef = useRef<ReturnType<
    typeof createPriwaTopographicLayer
  > | null>(null);
  const cogLayersRef = useRef<TileLayerWebGL[]>([]);
  const knownMosaicIdsRef = useRef<Set<string>>(new Set());
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [enabledMosaicIds, setEnabledMosaicIds] = useState<Set<string>>(
    new Set(),
  );
  const [isPlacingPoint, setPlacingPoint] = useState(false);
  const [selectedCoordinate, setSelectedCoordinate] =
    useState<IPriwaCoordinate | null>(null);
  const [selectedCoordinateSource, setSelectedCoordinateSource] =
    useState<PriwaCoordinateSource>("qr");
  const [editingPoint, setEditingPoint] = useState<IPriwaPoint | null>(null);
  const [formSessionId, setFormSessionId] = useState(0);
  const [isPointListOpen, setPointListOpen] = useState(false);
  const [baseLayer, setBaseLayer] = useState<PriwaBaseLayer>("aerial");
  const visibleMosaics = useMemo(
    () =>
      [...mosaics]
        .filter((mosaic) => mosaic.cogUrl.trim().length > 0)
        .sort(comparePriwaMosaics),
    [mosaics],
  );
  const enabledMosaics = useMemo(
    () => visibleMosaics.filter((mosaic) => enabledMosaicIds.has(mosaic.id)),
    [enabledMosaicIds, visibleMosaics],
  );
  const userLocation = useUserLocationLayer(mapRef);
  const {
    layer: userLocationLayer,
    locateUser,
    stop: stopUserLocation,
  } = userLocation;
  const {
    area: offlineBasemapArea,
    cacheState: basemapCacheState,
    cacheCurrentMapArea,
    clearArea: clearOfflineBasemapArea,
    isSupported: isOfflineBasemapSupported,
  } = usePriwaOfflineBasemap(projectId);

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

    const topographicLayer = createPriwaTopographicLayer();
    const dopLayer = createLglDop20Layer();
    const offlineAreaLayer = createPriwaOfflineAreaLayer();
    const pointLayer = createPriwaPointLayer([]);
    const previewLayer = createPriwaPreviewLayer();
    aerialLayerRef.current = dopLayer;
    topographicLayerRef.current = topographicLayer;
    offlineAreaLayerRef.current = offlineAreaLayer;
    pointLayerRef.current = pointLayer;
    previewLayerRef.current = previewLayer;

    const map = new Map({
      target: containerRef.current,
      layers: [
        topographicLayer,
        dopLayer,
        offlineAreaLayer,
        pointLayer,
        previewLayer,
        userLocationLayer,
      ],
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
      offlineAreaLayerRef.current = null;
      aerialLayerRef.current = null;
      topographicLayerRef.current = null;
      pointLayerRef.current = null;
      previewLayerRef.current = null;
      cogLayersRef.current = [];
    };
  }, [openPointForEditing, stopUserLocation, userLocationLayer]);

  useEffect(() => {
    aerialLayerRef.current?.setVisible(baseLayer === "aerial");
    topographicLayerRef.current?.setVisible(baseLayer === "topographic");
  }, [baseLayer]);

  useEffect(() => {
    const nextKnownIds = new Set(visibleMosaics.map((mosaic) => mosaic.id));
    const previousKnownIds = knownMosaicIdsRef.current;

    setEnabledMosaicIds((currentIds) => {
      const nextEnabledIds = new Set<string>();
      visibleMosaics.forEach((mosaic) => {
        if (!previousKnownIds.has(mosaic.id) || currentIds.has(mosaic.id)) {
          nextEnabledIds.add(mosaic.id);
        }
      });
      return nextEnabledIds;
    });

    knownMosaicIdsRef.current = nextKnownIds;
  }, [visibleMosaics]);

  useEffect(() => {
    const source = pointLayerRef.current?.getSource();
    if (!source) return;

    source.clear();
    points.forEach((point) =>
      source.addFeature(createPriwaPointFeature(point)),
    );
  }, [points]);

  useEffect(() => {
    const source = offlineAreaLayerRef.current?.getSource();
    if (!source) return;

    source.clear();
    if (offlineBasemapArea) {
      source.addFeature(
        createPriwaOfflineAreaFeature(offlineBasemapArea.extent3857),
      );
    }
  }, [offlineBasemapArea]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (cogLayersRef.current.length > 0) {
      cogLayersRef.current.forEach((layer) => {
        map.removeLayer(layer);
      });
      cogLayersRef.current = [];
    }

    if (enabledMosaics.length === 0) return;

    const cogLayers = createPriwaCogLayers(enabledMosaics);
    cogLayersRef.current = cogLayers;
    cogLayers.forEach((layer, index) => {
      layer.setZIndex(20 + (enabledMosaics.length - index) / 100);
      map.getLayers().insertAt(2 + index, layer);
    });
  }, [enabledMosaics]);

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
  const mosaicCount = visibleMosaics.length;
  const enabledMosaicCount = enabledMosaics.length;

  const setMosaicVisibility = useCallback(
    (mosaicId: string, checked: boolean) => {
      setEnabledMosaicIds((currentIds) => {
        const nextIds = new Set(currentIds);
        if (checked) {
          nextIds.add(mosaicId);
        } else {
          nextIds.delete(mosaicId);
        }
        return nextIds;
      });
    },
    [],
  );

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
  const basemapCachePercent =
    basemapCacheState.total > 0
      ? Math.round(
          ((basemapCacheState.cached + basemapCacheState.failed) /
            basemapCacheState.total) *
            100,
        )
      : 0;

  const handleCacheBasemapArea = useCallback(async () => {
    try {
      const area = await cacheCurrentMapArea(mapRef.current);
      message.success(
        `Basiskarte offline gespeichert (${area.cachedTileCount}/${area.tileCount} Kacheln)`,
      );
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : "Basiskarte konnte nicht offline gespeichert werden.",
      );
    }
  }, [cacheCurrentMapArea]);

  const handleClearBasemapArea = useCallback(async () => {
    await clearOfflineBasemapArea();
    message.success("Offline-Basiskartenbereich entfernt");
  }, [clearOfflineBasemapArea]);

  const layerPanel = (
    <div className="w-[21rem] max-w-[calc(100vw-3rem)] space-y-3">
      <div>
        <Typography.Text strong>Layer</Typography.Text>
        <div className="text-xs text-gray-500">
          PRIWA Punkte bleiben immer sichtbar.
        </div>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium text-gray-900">
          Kartenbasis
        </div>
        <Segmented<PriwaBaseLayer>
          block
          size="small"
          value={baseLayer}
          options={[
            { label: "Luftbild", value: "aerial" },
            { label: "Karte", value: "topographic" },
          ]}
          onChange={setBaseLayer}
        />
      </div>
      <div>
        <div className="text-sm font-medium text-gray-900">Drohnenlayer</div>
        <div className="text-xs text-gray-500">
          {isCogLoading
            ? "Lade Drohnenlayer..."
            : mosaicCount > 0
              ? `${enabledMosaicCount} von ${mosaicCount} Befliegung${
                  mosaicCount === 1 ? "" : "en"
                } sichtbar`
              : "Keine Drohnenlayer hinterlegt"}
        </div>
        {cogErrorMessage && (
          <div className="mt-1 text-xs text-red-600">{cogErrorMessage}</div>
        )}
        {mosaicCount > 0 && (
          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
            {visibleMosaics.map((mosaic) => {
              const isVisible = enabledMosaicIds.has(mosaic.id);
              const captureDate = formatPriwaMosaicDate(mosaic.captureDate);
              const uploadDate = formatPriwaMosaicDate(mosaic.createdAt);
              const authors =
                mosaic.authors.length > 0
                  ? mosaic.authors.join(", ")
                  : "Keine Autorenangabe";

              return (
                <div
                  key={mosaic.id}
                  className="rounded-md border border-slate-200 bg-white px-2 py-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-950">
                        {mosaic.label}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        Aufnahme: {captureDate ?? "ohne Datum"} · Upload:{" "}
                        {uploadDate ?? "ohne Datum"}
                      </div>
                    </div>
                    <Switch
                      size="small"
                      checked={isVisible}
                      aria-label={`${mosaic.label} anzeigen`}
                      onChange={(checked) =>
                        setMosaicVisibility(mosaic.id, checked)
                      }
                    />
                  </div>
                  <details className="mt-1 text-xs text-slate-500">
                    <summary className="cursor-pointer select-none">
                      Details
                    </summary>
                    <dl className="mt-1 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
                      <dt className="text-slate-400">Autoren</dt>
                      <dd className="min-w-0 break-words">{authors}</dd>
                      <dt className="text-slate-400">Dataset ID</dt>
                      <dd className="min-w-0 break-all">{mosaic.id}</dd>
                      {mosaic.additionalInformation && (
                        <>
                          <dt className="text-slate-400">Info</dt>
                          <dd className="min-w-0 break-words">
                            {mosaic.additionalInformation}
                          </dd>
                        </>
                      )}
                      <dt className="text-slate-400">COG</dt>
                      <dd className="min-w-0 break-all">{mosaic.cogUrl}</dd>
                    </dl>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const offlineMapPanel = (
    <div className="w-64 space-y-3">
      <div>
        <Typography.Text strong>Offline-Karten</Typography.Text>
        <div className="mt-1 text-xs text-gray-500">
          Speichert den aktuellen Ausschnitt plus Umgebung für Luftbild und
          Karte.
        </div>
      </div>
      {offlineBasemapArea && (
        <div className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">
          {offlineBasemapArea.cachedTileCount} Kacheln · Zoom{" "}
          {offlineBasemapArea.minZoom}-{offlineBasemapArea.maxZoom} ·{" "}
          {offlineBasemapArea.areaKm2.toFixed(2)} km²
        </div>
      )}
      <Button
        block
        size="small"
        type={offlineBasemapArea ? "default" : "primary"}
        icon={<DownloadOutlined />}
        loading={basemapCacheState.isCaching}
        disabled={!isOfflineBasemapSupported}
        onClick={() => void handleCacheBasemapArea()}
      >
        Ausschnitt + Umgebung speichern
      </Button>
      {basemapCacheState.isCaching && (
        <Progress
          percent={basemapCachePercent}
          size="small"
          status={basemapCacheState.failed > 0 ? "exception" : "active"}
        />
      )}
      {basemapCacheState.errorMessage && (
        <div className="text-xs text-red-600">
          {basemapCacheState.errorMessage}
        </div>
      )}
      {offlineBasemapArea && (
        <Button
          block
          danger
          size="small"
          icon={<DeleteOutlined />}
          disabled={basemapCacheState.isCaching}
          onClick={() => void handleClearBasemapArea()}
        >
          Bereich entfernen
        </Button>
      )}
      {!isOfflineBasemapSupported && (
        <div className="text-xs text-amber-700">
          Dieser Browser unterstützt den Offline-Kartenspeicher nicht.
        </div>
      )}
      {offlineBasemapArea && (
        <div className="text-xs text-gray-500">
          Die Umrisslinie auf der Karte zeigt den gespeicherten Bereich.
        </div>
      )}
    </div>
  );

  const offlineMapButtonTitle = offlineBasemapArea
    ? "Offline-Karten verwalten"
    : "Offline-Karten speichern";

  const offlineMapButtonIcon = basemapCacheState.isCaching ? (
    <DownloadOutlined spin />
  ) : (
    <DownloadOutlined />
  );

  const offlineMapButtonClassName = offlineBasemapArea
    ? "pointer-events-auto border-emerald-600 text-emerald-700 shadow-md"
    : "pointer-events-auto shadow-md";

  return (
    <div
      data-testid="priwa-field-map"
      className="relative h-full min-h-[100dvh] w-full overflow-hidden bg-neutral-950"
      onPointerDownCapture={requestDeferredOrientationPermission}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {!isPlacingPoint && (
        <>
          <div className="priwa-map-control-stack pointer-events-none absolute left-4 z-10 flex flex-col gap-2">
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
                icon={<MapLayersIcon />}
                aria-label="Layer auswählen"
              />
            </Popover>
            <Popover
              trigger="click"
              placement="rightTop"
              content={offlineMapPanel}
            >
              <Button
                className={offlineMapButtonClassName}
                type={offlineBasemapArea ? "primary" : "default"}
                shape="circle"
                size="large"
                icon={offlineMapButtonIcon}
                aria-label={offlineMapButtonTitle}
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
              shape="circle"
              icon={<PlusOutlined />}
              tooltip={{ title: "Punkt aufnehmen", placement: "left" }}
              onClick={openNewPointDrawer}
              aria-label="Punkt aufnehmen"
              style={{
                right:
                  "max(20px, calc(env(safe-area-inset-right, 0px) + 20px))",
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
        <div className="priwa-map-status-stack pointer-events-none absolute right-4 z-10 flex max-w-[calc(100%-5.75rem)] flex-col items-end gap-1.5">
          {locationHintLabel && (
            <div className="rounded-md bg-white/90 px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm backdrop-blur">
              {locationHintLabel}
            </div>
          )}
          <PriwaOfflineStatus
            syncSummary={syncSummary}
            onSyncNow={onSyncNow}
          />
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
