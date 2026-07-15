import {
  Alert,
  Button,
  Drawer,
  FloatButton,
  Popover,
  Progress,
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
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import View from "ol/View";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { createStandardMapControls } from "../../utils/basemaps";
import parseBBox from "../../utils/parseBBox";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useUserLocationLayer } from "../../hooks/useUserLocationLayer";
import { createLglDop20Layer } from "./createLglDop20Layer";
import { createPriwaTopographicLayer } from "./createPriwaTopographicLayer";
import {
  createPriwaOfflineAreaFeature,
  createPriwaOfflineAreaLayer,
} from "./createPriwaOfflineAreaLayer";
import { createPriwaCogLayers } from "./createPriwaCogLayer";
import {
  createPriwaMosaicFootprintFeature,
  createPriwaMosaicFootprintLayer,
} from "./createPriwaMosaicFootprintLayer";
import {
  createPriwaPointFeature,
  createPriwaPointLayer,
  createPriwaPreviewFeature,
  createPriwaPreviewLayer,
} from "./createPriwaPointLayer";
import PriwaPointDrawer from "./PriwaPointDrawer";
import PriwaLayerPanel, { type PriwaBaseLayer } from "./PriwaLayerPanel";
import PriwaPointListPanel from "./PriwaPointListPanel";
import PriwaOfflineStatus from "./PriwaOfflineStatus";
import { usePriwaOfflineBasemap } from "./usePriwaOfflineBasemap";
import { usePriwaMosaicMatches } from "./usePriwaMosaicMatches";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import type {
  IPriwaCoordinate,
  IPriwaPoint,
  PriwaCoordinateSource,
} from "./types";

const FIELD_CENTER: [number, number] = [8.18013, 48.45596];

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
  const mosaicFootprintLayerRef = useRef<ReturnType<
    typeof createPriwaMosaicFootprintLayer
  > | null>(null);
  const cogLayersRef = useRef<TileLayerWebGL[]>([]);
  const knownMosaicIdsRef = useRef<Set<string>>(new Set());
  const hoveredMosaicIdRef = useRef<string | null>(null);
  const selectMosaicFromFootprintRef = useRef<(mosaicId: string) => void>(
    () => {
      return;
    },
  );
  const openPointForEditingRef = useRef<(point: IPriwaPoint) => void>(() => {
    return;
  });
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [enabledMosaicIds, setEnabledMosaicIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedMosaicId, setSelectedMosaicId] = useState<string | null>(null);
  const [hoveredMosaicId, setHoveredMosaicId] = useState<string | null>(null);
  const [isPlacingPoint, setPlacingPoint] = useState(false);
  const [selectedCoordinate, setSelectedCoordinate] =
    useState<IPriwaCoordinate | null>(null);
  const [selectedCoordinateSource, setSelectedCoordinateSource] =
    useState<PriwaCoordinateSource>("qr");
  const [editingPoint, setEditingPoint] = useState<IPriwaPoint | null>(null);
  const [formSessionId, setFormSessionId] = useState(0);
  const [isPointListOpen, setPointListOpen] = useState(false);
  const [focusedPointId, setFocusedPointId] = useState<string | null>(null);
  const [isLayerPanelOpen, setLayerPanelOpen] = useState(false);
  const [baseLayer, setBaseLayer] = useState<PriwaBaseLayer>("aerial");
  const isMobile = useIsMobile();
  const { candidateCount, matchedMosaics, mosaicIdByPointId } =
    usePriwaMosaicMatches(points, mosaics);
  const visibleMosaics = useMemo(
    () => matchedMosaics.map(({ mosaic }) => mosaic),
    [matchedMosaics],
  );
  const enabledMosaics = useMemo(
    () => visibleMosaics.filter((mosaic) => enabledMosaicIds.has(mosaic.id)),
    [enabledMosaicIds, visibleMosaics],
  );
  const selectedMosaic = useMemo(
    () =>
      selectedMosaicId
        ? (visibleMosaics.find((mosaic) => mosaic.id === selectedMosaicId) ??
          null)
        : null,
    [selectedMosaicId, visibleMosaics],
  );
  const hoveredMosaic = useMemo(
    () =>
      hoveredMosaicId
        ? (visibleMosaics.find((mosaic) => mosaic.id === hoveredMosaicId) ??
          null)
        : null,
    [hoveredMosaicId, visibleMosaics],
  );
  const inspectedMosaic = hoveredMosaic ?? selectedMosaic;
  const inspectedMosaicIsHovered = hoveredMosaic !== null;
  const isInspectedMosaicVisible =
    inspectedMosaic !== null && enabledMosaicIds.has(inspectedMosaic.id);
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

  useEffect(() => {
    if (
      selectedMosaicId &&
      !visibleMosaics.some((mosaic) => mosaic.id === selectedMosaicId)
    ) {
      setSelectedMosaicId(null);
    }
  }, [selectedMosaicId, visibleMosaics]);

  useEffect(() => {
    if (
      hoveredMosaicId &&
      !visibleMosaics.some((mosaic) => mosaic.id === hoveredMosaicId)
    ) {
      hoveredMosaicIdRef.current = null;
      setHoveredMosaicId(null);
    }
  }, [hoveredMosaicId, visibleMosaics]);

  const selectMosaicFromFootprint = useCallback((mosaicId: string) => {
    setSelectedMosaicId(mosaicId);
    setLayerPanelOpen(true);
  }, []);

  useEffect(() => {
    selectMosaicFromFootprintRef.current = selectMosaicFromFootprint;
  }, [selectMosaicFromFootprint]);

  const selectMatchedMosaicForPoint = useCallback(
    (point: IPriwaPoint) => {
      const mosaicId = mosaicIdByPointId[point.id];
      if (!mosaicId) return;

      setSelectedMosaicId(mosaicId);
    },
    [mosaicIdByPointId],
  );

  const openPointForEditing = useCallback(
    (point: IPriwaPoint) => {
      selectMatchedMosaicForPoint(point);
      setPointListOpen(false);
      setFormSessionId((currentSessionId) => currentSessionId + 1);
      setEditingPoint(point);
      setSelectedCoordinate({ lat: point.lat, lon: point.lon });
      setSelectedCoordinateSource(point.coordinateSource);
      setDrawerOpen(true);
    },
    [selectMatchedMosaicForPoint],
  );

  useEffect(() => {
    openPointForEditingRef.current = openPointForEditing;
  }, [openPointForEditing]);

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
    const mosaicFootprintLayer = createPriwaMosaicFootprintLayer();
    const pointLayer = createPriwaPointLayer([]);
    const previewLayer = createPriwaPreviewLayer();
    aerialLayerRef.current = dopLayer;
    topographicLayerRef.current = topographicLayer;
    offlineAreaLayerRef.current = offlineAreaLayer;
    mosaicFootprintLayerRef.current = mosaicFootprintLayer;
    pointLayerRef.current = pointLayer;
    previewLayerRef.current = previewLayer;

    const map = new Map({
      target: containerRef.current,
      layers: [
        topographicLayer,
        dopLayer,
        offlineAreaLayer,
        mosaicFootprintLayer,
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
          layerFilter: (layer) => layer === pointLayerRef.current,
        },
      );

      if (pointFeature) {
        openPointForEditingRef.current(pointFeature);
        return;
      }

      const mosaicId = map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const id = feature.get("mosaicId") as string | undefined;
          return id ?? null;
        },
        {
          hitTolerance: 12,
          layerFilter: (layer) => layer === mosaicFootprintLayerRef.current,
        },
      );

      if (mosaicId) {
        selectMosaicFromFootprintRef.current(mosaicId);
      }
    });

    const clearHoveredMosaic = () => {
      if (hoveredMosaicIdRef.current === null) return;

      hoveredMosaicIdRef.current = null;
      setHoveredMosaicId(null);
      map.getTargetElement().style.cursor = "";
    };

    const pointerMoveKey = map.on("pointermove", (event) => {
      if (isPlacingPointRef.current || event.dragging) {
        clearHoveredMosaic();
        return;
      }

      const mosaicId = map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const id = feature.get("mosaicId") as string | undefined;
          return id ?? null;
        },
        {
          hitTolerance: 12,
          layerFilter: (layer) => layer === mosaicFootprintLayerRef.current,
        },
      );

      const nextHoveredMosaicId = mosaicId ?? null;
      if (hoveredMosaicIdRef.current === nextHoveredMosaicId) return;

      hoveredMosaicIdRef.current = nextHoveredMosaicId;
      setHoveredMosaicId(nextHoveredMosaicId);
      map.getTargetElement().style.cursor = nextHoveredMosaicId
        ? "pointer"
        : "";
    });

    const viewport = map.getViewport();
    viewport.addEventListener("pointerleave", clearHoveredMosaic);

    return () => {
      stopUserLocation();
      unByKey(clickKey);
      unByKey(pointerMoveKey);
      viewport.removeEventListener("pointerleave", clearHoveredMosaic);
      map.setTarget(undefined);
      mapRef.current = null;
      offlineAreaLayerRef.current = null;
      aerialLayerRef.current = null;
      topographicLayerRef.current = null;
      mosaicFootprintLayerRef.current = null;
      pointLayerRef.current = null;
      previewLayerRef.current = null;
      cogLayersRef.current = [];
    };
  }, [stopUserLocation, userLocationLayer]);

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
    const source = mosaicFootprintLayerRef.current?.getSource();
    if (!source) return;

    source.clear();
    visibleMosaics.forEach((mosaic) => {
      const feature = createPriwaMosaicFootprintFeature({
        mosaic,
        isSelected: mosaic.id === selectedMosaicId,
        isVisible: enabledMosaicIds.has(mosaic.id),
      });
      if (feature) {
        source.addFeature(feature);
      }
    });
  }, [enabledMosaicIds, selectedMosaicId, visibleMosaics]);

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

  const focusPointOnMap = useCallback(
    (point: IPriwaPoint) => {
      selectMatchedMosaicForPoint(point);
      zoomToCoordinate(point);
    },
    [selectMatchedMosaicForPoint, zoomToCoordinate],
  );

  const openPointInTable = useCallback((point: IPriwaPoint) => {
    setFocusedPointId(point.id);
    setLayerPanelOpen(false);
    setPointListOpen(true);
  }, []);

  const zoomToMosaicFootprint = useCallback((mosaic: IPriwaMosaic) => {
    if (!mosaic.bbox) {
      message.warning(
        "Für diesen Drohnenlayer ist keine Kartengrenze verfügbar.",
      );
      return;
    }

    const bbox = parseBBox(mosaic.bbox);
    if (!bbox) {
      message.warning("Kartengrenze konnte nicht gelesen werden.");
      return;
    }

    setSelectedMosaicId(mosaic.id);
    mapRef.current
      ?.getView()
      .fit(transformExtent(bbox, "EPSG:4326", "EPSG:3857"), {
        duration: 500,
        maxZoom: 19,
        padding: [96, 96, 96, 96],
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
  const isMatchingMosaics = isCogLoading || isLoadingPoints;

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

  const layerPanelProps = {
    baseLayer,
    candidateMosaicCount: candidateCount,
    matchedMosaics,
    enabledMosaicIds,
    selectedMosaicId,
    hoveredMosaicId,
    isLoading: isMatchingMosaics,
    isOpen: isLayerPanelOpen,
    errorMessage: cogErrorMessage,
    onBaseLayerChange: setBaseLayer,
    onSelectMosaic: setSelectedMosaicId,
    onSetMosaicVisibility: setMosaicVisibility,
    onZoomToMosaic: zoomToMosaicFootprint,
    onOpenPointInTable: openPointInTable,
  };
  const layerPanel = <PriwaLayerPanel {...layerPanelProps} />;

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
            {isMobile ? (
              <Button
                className="pointer-events-auto shadow-md"
                shape="circle"
                size="large"
                icon={<MapLayersIcon />}
                type={isLayerPanelOpen ? "primary" : "default"}
                aria-pressed={isLayerPanelOpen}
                aria-label="Layer auswählen"
                onClick={() => setLayerPanelOpen(true)}
              />
            ) : (
              <Popover
                trigger="click"
                placement="rightTop"
                content={layerPanel}
                open={isLayerPanelOpen}
                onOpenChange={setLayerPanelOpen}
              >
                <Button
                  className="pointer-events-auto shadow-md"
                  shape="circle"
                  size="large"
                  icon={<MapLayersIcon />}
                  aria-label="Layer auswählen"
                />
              </Popover>
            )}
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
                onClick={() => {
                  setFocusedPointId(null);
                  setPointListOpen((currentIsOpen) => !currentIsOpen);
                }}
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

      {!isPlacingPoint && isMobile && (
        <Drawer
          title="Layer"
          placement="bottom"
          height="82dvh"
          open={isLayerPanelOpen}
          onClose={() => setLayerPanelOpen(false)}
          rootClassName="priwa-layer-sheet-root"
          className="md:hidden"
          styles={{
            header: { padding: "12px 16px" },
            body: {
              padding:
                "12px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)",
              overflowY: "auto",
            },
          }}
        >
          <PriwaLayerPanel {...layerPanelProps} variant="sheet" />
        </Drawer>
      )}

      {isPointListOpen && !isPlacingPoint && (
        <PriwaPointListPanel
          points={points}
          projectName={projectName}
          isLoading={isLoadingPoints}
          focusedPointId={focusedPointId}
          onClose={() => {
            setFocusedPointId(null);
            setPointListOpen(false);
          }}
          onEditPoint={openPointForEditing}
          onZoomToPoint={focusPointOnMap}
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
          {inspectedMosaic && (
            <div className="max-w-sm rounded-md bg-white/90 px-2.5 py-1.5 text-right text-xs font-medium text-gray-700 shadow-sm backdrop-blur">
              {inspectedMosaicIsHovered
                ? "Drohnenlayer unter Cursor"
                : "Drohnenlayer"}
              : <span className="text-slate-950">{inspectedMosaic.label}</span>{" "}
              {isInspectedMosaicVisible ? "sichtbar" : "ausgeblendet"}
            </div>
          )}
          <PriwaOfflineStatus syncSummary={syncSummary} onSyncNow={onSyncNow} />
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
