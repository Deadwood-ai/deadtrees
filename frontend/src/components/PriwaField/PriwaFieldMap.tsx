import { Alert, App, Button, FloatButton, Tooltip } from "antd";
import {
  AimOutlined,
  EnvironmentOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import "ol/ol.css";
import { Map } from "ol";
import { defaults as defaultInteractions } from "ol/interaction";
import { unByKey } from "ol/Observable";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import View from "ol/View";
import { boundingExtent } from "ol/extent";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";

import { createStandardMapControls } from "../../utils/basemaps";
import parseBBox from "../../utils/parseBBox";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useUserLocationLayer } from "../../hooks/useUserLocationLayer";
import { createLglDop20Layer } from "./createLglDop20Layer";
import { PRIWA_COG_MAX_ZOOM } from "./createPriwaCogLayer";
import { createPriwaTopographicLayer } from "./createPriwaTopographicLayer";
import { createPriwaOfflineAreaLayer } from "./createPriwaOfflineAreaLayer";
import { createPriwaMosaicFootprintLayer } from "./createPriwaMosaicFootprintLayer";
import {
  createPriwaPointFeature,
  createPriwaPointLayer,
  createPriwaPreviewFeature,
  createPriwaPreviewLayer,
} from "./createPriwaPointLayer";
import { createPriwaBefallsgruppeLayer } from "./createPriwaBefallsgruppeLayer";
import {
  createPriwaWarnkarteLayer,
  fitPriwaWarnkarteLayer,
  setPriwaWarnkarteLayerData,
} from "./createPriwaWarnkarteLayer";
import { PriwaWarnkarteZoomControl } from "./PriwaWarnkarteMapControls";
import { attachPriwaWarnkarteInteraction } from "./priwaWarnkarteMapInteraction";
import PriwaPointDrawer from "./PriwaPointDrawer";
import PriwaPointListPanel from "./PriwaPointListPanel";
import PriwaOfflineStatus from "./PriwaOfflineStatus";
import PriwaBefallsgruppeEditor from "./PriwaBefallsgruppeEditor";
import PriwaBaseLayerControl from "./PriwaBaseLayerControl";
import PriwaMobileFieldTools from "./PriwaMobileFieldTools";
import PriwaOfflineAreaSelection from "./PriwaOfflineAreaSelection";
import PriwaOfflineMapControl from "./PriwaOfflineMapControl";
import PriwaReviewWorkbench, {
  type PriwaReviewDetailMode,
} from "./PriwaReviewWorkbench";
import {
  getPriwaMapFitPadding,
  getPriwaReviewMapCenter,
  getPriwaReviewTargetPixel,
} from "./priwaReviewMapFocus";
import { usePriwaOfflineBasemap } from "./usePriwaOfflineBasemap";
import { usePriwaOfflineAreaLayer } from "./usePriwaOfflineAreaLayer";
import {
  usePriwaOfflineSelectionPlan,
  type IPriwaOfflineSelectionPlan,
} from "./usePriwaOfflineSelectionPlan";
import { usePriwaMapInteractionMode } from "./usePriwaMapInteractionMode";
import { usePriwaReviewController } from "./usePriwaReviewController";
import { usePriwaReviewMapLayers } from "./usePriwaReviewMapLayers";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";
import type { IPriwaSyncSummary } from "./priwaOfflineSync";
import type { IPriwaWarnkarteOverlay } from "../../api/priwaWarnkarte";
import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeSaveInput,
  PriwaBaseLayer,
  IPriwaCoordinate,
  IPriwaPoint,
  PriwaCoordinateSource,
} from "./types";

const FIELD_CENTER: [number, number] = [8.18013, 48.45596];
const EMPTY_MOSAIC_IDS = new Set<string>();

interface PriwaFieldMapProps {
  points: IPriwaPoint[];
  projectId: string;
  isLoadingPoints?: boolean;
  isSavingPoint?: boolean;
  projectName: string;
  warnkarteOverlay?: IPriwaWarnkarteOverlay | null;
  warnkarteVisible?: boolean;
  additionalMapControl?: ReactNode;
  reviewDetailMode?: PriwaReviewDetailMode;
  mosaics?: IPriwaMosaic[];
  groups?: IPriwaBefallsgruppe[];
  isCogLoading?: boolean;
  isLoadingGroups?: boolean;
  isSavingGroup?: boolean;
  groupsErrorMessage?: string | null;
  cogErrorMessage?: string | null;
  errorMessage?: string | null;
  syncSummary?: IPriwaSyncSummary;
  onAddPoint: (point: IPriwaPoint) => Promise<void>;
  onUpdatePoint: (point: IPriwaPoint) => Promise<void>;
  onDeletePoint: (pointId: string) => Promise<void>;
  onSaveGroup: (input: IPriwaBefallsgruppeSaveInput) => Promise<unknown>;
  onAssignFlightToGroup: (input: {
    groupId: string;
    datasetId: string;
  }) => Promise<unknown>;
  onDeleteGroup: (groupId: string) => Promise<unknown>;
  onSetFlightType: (input: {
    datasetId: string;
    flightType: PriwaFlightType;
  }) => Promise<unknown>;
  isClassifyingFlight?: boolean;
  onSyncNow?: () => Promise<void>;
}

export default function PriwaFieldMap({
  points,
  projectId,
  isLoadingPoints = false,
  isSavingPoint = false,
  projectName,
  warnkarteOverlay = null,
  warnkarteVisible = true,
  additionalMapControl,
  reviewDetailMode,
  mosaics = [],
  groups = [],
  isCogLoading = false,
  isLoadingGroups = false,
  isSavingGroup = false,
  groupsErrorMessage = null,
  cogErrorMessage = null,
  errorMessage = null,
  syncSummary,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  onSaveGroup,
  onAssignFlightToGroup,
  onDeleteGroup,
  onSetFlightType,
  isClassifyingFlight = false,
  onSyncNow,
}: PriwaFieldMapProps) {
  const { message } = App.useApp();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const hasRequestedOrientationFromInteractionRef = useRef(false);
  const hasFittedInitialMobilePointsRef = useRef(false);
  const pointLayerRef = useRef<ReturnType<typeof createPriwaPointLayer> | null>(
    null,
  );
  const groupLayerRef = useRef<ReturnType<
    typeof createPriwaBefallsgruppeLayer
  > | null>(null);
  const warnkarteLayerRef = useRef<ReturnType<
    typeof createPriwaWarnkarteLayer
  > | null>(null);
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
  const selectReviewItemFromMosaicRef = useRef<(mosaicId: string) => void>(
    () => undefined,
  );
  const selectReviewItemFromGroupRef = useRef<(groupId: string) => void>(
    () => undefined,
  );
  const selectReviewItemFromPointRef = useRef<(point: IPriwaPoint) => void>(
    () => undefined,
  );
  const openPointForEditingRef = useRef<(point: IPriwaPoint) => void>(() => {
    return;
  });
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [selectedCoordinate, setSelectedCoordinate] =
    useState<IPriwaCoordinate | null>(null);
  const [selectedCoordinateSource, setSelectedCoordinateSource] =
    useState<PriwaCoordinateSource>("qr");
  const [editingPoint, setEditingPoint] = useState<IPriwaPoint | null>(null);
  const [formSessionId, setFormSessionId] = useState(0);
  const [isPointListOpen, setPointListOpen] = useState(false);
  const [focusedPointId, setFocusedPointId] = useState<string | null>(null);
  const [reviewPointId, setReviewPointId] = useState<string | null>(null);
  const [baseLayer, setBaseLayer] = useState<PriwaBaseLayer>("aerial");
  const [isOfflineMapModeActive, setOfflineMapModeActive] = useState(false);
  const mapInteraction = usePriwaMapInteractionMode();
  const { modeRef, setMode } = mapInteraction;
  const isMobile = useIsMobile("lg");
  const userLocation = useUserLocationLayer(mapRef);
  const {
    layer: userLocationLayer,
    locateUser,
    stop: stopUserLocation,
  } = userLocation;
  const {
    areas: offlineBasemapAreas,
    cacheState: basemapCacheState,
    cacheCurrentMapArea,
    clearAreas: clearOfflineBasemapAreas,
    isSupported: isOfflineBasemapSupported,
  } = usePriwaOfflineBasemap(projectId);
  const offlineSelectionPlan = usePriwaOfflineSelectionPlan(
    mapRef,
    mapInteraction.isSelectingOfflineArea,
  );
  usePriwaOfflineAreaLayer(
    offlineAreaLayerRef,
    offlineBasemapAreas,
    isOfflineMapModeActive || mapInteraction.isSelectingOfflineArea,
  );

  const zoomToTrees = useCallback(
    (treeIds: string[]) => {
      const coordinates = points
        .filter((point) => treeIds.includes(point.id))
        .map((point) => fromLonLat([point.lon, point.lat]));
      const view = mapRef.current?.getView();
      if (!view || coordinates.length === 0) return;
      if (coordinates.length === 1) {
        view.animate({ center: coordinates[0], zoom: 20, duration: 500 });
        return;
      }
      view.fit(boundingExtent(coordinates), {
        duration: 500,
        maxZoom: 20,
        padding: [120, 120, 120, 120],
      });
    },
    [points],
  );

  const zoomToMosaicFootprint = useCallback(
    (mosaic: IPriwaMosaic) => {
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

      mapRef.current
        ?.getView()
        .fit(transformExtent(bbox, "EPSG:4326", "EPSG:3857"), {
          duration: 500,
          maxZoom: 19,
          padding: [96, 96, 96, 96],
        });
    },
    [message],
  );

  const review = usePriwaReviewController({
    projectId,
    points,
    mosaics,
    groups,
    isMobile,
    isLoadingPoints,
    isLoadingGroups,
    isCogLoading,
    groupsErrorMessage,
    onSaveGroup,
    onDeleteGroup,
    onSetFlightType,
    onAssignFlightToGroup,
    zoomToTrees,
    zoomToMosaicFootprint,
  });
  const {
    matchedMosaics,
    reviewMosaics,
    enabledMosaics,
    enabledMosaicIds,
    selectedMosaicId,
    selectMatchedMosaicForPoint,
    setFlightType,
    reviewItems,
    selectedReviewKey,
    selectedTreeIds,
    selectedGroupId,
    isWorkspaceLoading,
    groupEditorDraft,
    setGroupEditorDraft,
    selectReviewItem,
    selectReviewItemFromMosaic,
    selectReviewItemFromGroup,
    selectReviewItemFromPoint,
    saveGroup,
    deleteGroup,
    assignFlight,
    setMosaicVisibility,
    createGroup,
    createGroupForFlight,
  } = review;
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
    if (!containerRef.current || mapRef.current) return;

    const topographicLayer = createPriwaTopographicLayer();
    const dopLayer = createLglDop20Layer();
    const offlineAreaLayer = createPriwaOfflineAreaLayer();
    const mosaicFootprintLayer = createPriwaMosaicFootprintLayer();
    const warnkarteLayer = createPriwaWarnkarteLayer();
    const groupLayer = createPriwaBefallsgruppeLayer();
    const pointLayer = createPriwaPointLayer([]);
    const previewLayer = createPriwaPreviewLayer();
    aerialLayerRef.current = dopLayer;
    topographicLayerRef.current = topographicLayer;
    offlineAreaLayerRef.current = offlineAreaLayer;
    mosaicFootprintLayerRef.current = mosaicFootprintLayer;
    warnkarteLayerRef.current = warnkarteLayer;
    groupLayerRef.current = groupLayer;
    pointLayerRef.current = pointLayer;
    previewLayerRef.current = previewLayer;

    const map = new Map({
      target: containerRef.current,
      layers: [
        topographicLayer,
        dopLayer,
        offlineAreaLayer,
        warnkarteLayer,
        mosaicFootprintLayer,
        groupLayer,
        pointLayer,
        previewLayer,
        userLocationLayer,
      ],
      view: new View({
        center: fromLonLat(FIELD_CENTER),
        zoom: 19,
        minZoom: 8,
        maxZoom: PRIWA_COG_MAX_ZOOM,
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
    const detachWarnkarteInteraction = attachPriwaWarnkarteInteraction(
      map,
      warnkarteLayer,
      () => modeRef.current === "browse",
    );

    const clickKey = map.on("singleclick", (event) => {
      if (modeRef.current !== "browse") return;

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
        if (window.matchMedia("(max-width: 767px)").matches) {
          openPointForEditingRef.current(pointFeature);
        } else {
          selectReviewItemFromPointRef.current(pointFeature);
        }
        return;
      }

      const groupId = map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const id = feature.get("groupId") as string | undefined;
          return id ?? null;
        },
        {
          hitTolerance: 12,
          layerFilter: (layer) => layer === groupLayerRef.current,
        },
      );

      if (groupId) {
        selectReviewItemFromGroupRef.current(groupId);
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
        if (!window.matchMedia("(max-width: 767px)").matches) {
          selectReviewItemFromMosaicRef.current(mosaicId);
        }
        return;
      }
    });

    return () => {
      stopUserLocation();
      detachWarnkarteInteraction();
      unByKey(clickKey);
      map.setTarget(undefined);
      mapRef.current = null;
      offlineAreaLayerRef.current = null;
      aerialLayerRef.current = null;
      topographicLayerRef.current = null;
      mosaicFootprintLayerRef.current = null;
      warnkarteLayerRef.current = null;
      groupLayerRef.current = null;
      pointLayerRef.current = null;
      previewLayerRef.current = null;
    };
  }, [modeRef, stopUserLocation, userLocationLayer]);

  useEffect(() => {
    if (!warnkarteLayerRef.current) return;
    setPriwaWarnkarteLayerData(warnkarteLayerRef.current, warnkarteOverlay);
  }, [warnkarteOverlay]);

  useEffect(() => {
    warnkarteLayerRef.current?.setVisible(warnkarteVisible);
  }, [warnkarteVisible]);

  useEffect(() => {
    aerialLayerRef.current?.setVisible(baseLayer === "aerial");
    topographicLayerRef.current?.setVisible(baseLayer === "topographic");
  }, [baseLayer]);

  useEffect(() => {
    const source = pointLayerRef.current?.getSource();
    if (!source) return;

    source.clear();
    points.forEach((point) =>
      source.addFeature(
        createPriwaPointFeature(
          point,
          selectedTreeIds.has(point.id),
          point.id === reviewPointId,
        ),
      ),
    );
  }, [points, reviewPointId, selectedTreeIds]);

  useEffect(() => {
    if (
      !isMobile ||
      hasFittedInitialMobilePointsRef.current ||
      points.length === 0 ||
      !mapRef.current
    ) {
      return;
    }

    const coordinates = points.map((point) =>
      fromLonLat([point.lon, point.lat]),
    );
    mapRef.current.getView().fit(boundingExtent(coordinates), {
      duration: 500,
      maxZoom: 19,
      padding: [150, 48, 130, 48],
    });
    hasFittedInitialMobilePointsRef.current = true;
  }, [isMobile, points]);

  usePriwaReviewMapLayers({
    mapRef,
    groupLayerRef,
    mosaicFootprintLayerRef,
    groups: isMobile ? [] : groups,
    points,
    matchedMosaics: isMobile ? [] : matchedMosaics,
    reviewMosaics: isMobile ? [] : reviewMosaics,
    enabledMosaics: isMobile ? [] : enabledMosaics,
    enabledMosaicIds: isMobile ? EMPTY_MOSAIC_IDS : enabledMosaicIds,
    selectedMosaicId: isMobile ? null : selectedMosaicId,
    selectedGroupId: isMobile ? null : selectedGroupId,
  });

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

  const zoomToWarnkarte = useCallback(() => {
    const map = mapRef.current;
    const layer = warnkarteLayerRef.current;
    if (!map || !layer) return;
    fitPriwaWarnkarteLayer(
      map,
      layer,
      getPriwaMapFitPadding(map.getTargetElement(), isMobile),
    );
  }, [isMobile]);

  const focusPointOnMap = useCallback(
    (point: IPriwaPoint) => {
      selectMatchedMosaicForPoint(point);
      zoomToCoordinate(point);
    },
    [selectMatchedMosaicForPoint, zoomToCoordinate],
  );

  const focusReviewPointOnMap = useCallback((point: IPriwaPoint) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const map = mapRef.current;
        const mapSize = map?.getSize();
        const view = map?.getView();
        if (!map || !mapSize || !view) return;

        const zoom = 20;
        const resolution = view.getResolutionForZoom(zoom);
        const mapRect = map.getTargetElement().getBoundingClientRect();
        const queueRect = document
          .querySelector<HTMLElement>("[data-priwa-review-queue-panel]")
          ?.getBoundingClientRect();
        const treePanelRect = document
          .querySelector<HTMLElement>("[data-priwa-review-tree-panel]")
          ?.getBoundingClientRect();
        const targetPixel = getPriwaReviewTargetPixel(
          mapRect,
          queueRect ?? null,
          treePanelRect ?? null,
        );
        const center = getPriwaReviewMapCenter(
          fromLonLat([point.lon, point.lat]),
          mapSize,
          targetPixel,
          resolution,
        );
        view.animate({ center, zoom, duration: 500 });
      }),
    );
  }, []);

  useEffect(() => {
    selectReviewItemFromMosaicRef.current = (mosaicId) => {
      setReviewPointId(null);
      selectReviewItemFromMosaic(mosaicId);
    };
    selectReviewItemFromGroupRef.current = (groupId) => {
      setReviewPointId(null);
      selectReviewItemFromGroup(groupId);
    };
    selectReviewItemFromPointRef.current = (point) => {
      setReviewPointId(point.id);
      selectReviewItemFromPoint(point);
    };
  }, [
    selectReviewItemFromGroup,
    selectReviewItemFromMosaic,
    selectReviewItemFromPoint,
  ]);

  useEffect(() => {
    if (reviewPointId && !points.some((point) => point.id === reviewPointId)) {
      setReviewPointId(null);
    }
  }, [points, reviewPointId]);

  const selectReviewPoint = useCallback(
    (point: IPriwaPoint) => {
      setReviewPointId(point.id);
      selectReviewItemFromPoint(point);
      selectMatchedMosaicForPoint(point);
    },
    [selectMatchedMosaicForPoint, selectReviewItemFromPoint],
  );

  const focusSelectedReviewPoint = useCallback(
    (point: IPriwaPoint) => {
      selectReviewPoint(point);
      focusReviewPointOnMap(point);
    },
    [focusReviewPointOnMap, selectReviewPoint],
  );

  const openReviewPointForEditing = useCallback(
    (point: IPriwaPoint) => {
      selectReviewPoint(point);
      requestAnimationFrame(() => openPointForEditing(point));
    },
    [openPointForEditing, selectReviewPoint],
  );

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
    setMode("place-point");
  }, [setMode]);

  const cancelMapPlacement = useCallback(() => {
    setMode("browse");
    setDrawerOpen(true);
  }, [setMode]);

  const acceptMapPlacement = useCallback(() => {
    const center = mapRef.current?.getView().getCenter();
    if (!center) return;

    const [lon, lat] = toLonLat(center);
    setSelectedCoordinate({ lat, lon });
    setSelectedCoordinateSource("map");
    setMode("browse");
    setDrawerOpen(true);
  }, [setMode]);

  const startOfflineAreaSelection = useCallback(() => {
    setDrawerOpen(false);
    setPointListOpen(false);
    setOfflineMapModeActive(false);
    setMode("select-offline-area");
  }, [setMode]);

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
        : null;
  const handleAddPoint = useCallback(
    async (point: IPriwaPoint) => {
      await onAddPoint(point);
      message.success("Käferbaum gespeichert");
    },
    [message, onAddPoint],
  );

  const handleUpdatePoint = useCallback(
    async (point: IPriwaPoint) => {
      await onUpdatePoint(point);
      message.success("Käferbaum aktualisiert");
    },
    [message, onUpdatePoint],
  );

  const handleDeletePoint = useCallback(
    async (pointId: string) => {
      await onDeletePoint(pointId);
      message.success("Käferbaum gelöscht");
      setDrawerOpen(false);
      setEditingPoint(null);
    },
    [message, onDeletePoint],
  );

  const handleCacheBasemapArea = useCallback(
    async (selectionPlan: IPriwaOfflineSelectionPlan) => {
      try {
        const area = await cacheCurrentMapArea(selectionPlan);
        message.success(
          `Basiskarte offline gespeichert (${area.cachedTileCount}/${area.tileCount} Kacheln)`,
        );
        setMode("browse");
        setOfflineMapModeActive(true);
      } catch (error) {
        message.error(
          error instanceof Error
            ? error.message
            : "Basiskarte konnte nicht offline gespeichert werden.",
        );
      }
    },
    [cacheCurrentMapArea, message, setMode],
  );

  const handleClearBasemapArea = useCallback(async () => {
    await clearOfflineBasemapAreas();
    message.success("Offline-Basiskartenbereiche entfernt");
  }, [clearOfflineBasemapAreas, message]);

  const dataErrorMessage =
    errorMessage ?? groupsErrorMessage ?? cogErrorMessage;
  const isReviewTreeEditing =
    !isMobile &&
    isDrawerOpen &&
    !!editingPoint &&
    editingPoint.id === reviewPointId;
  const closeReviewTree = useCallback(() => {
    setReviewPointId(null);
    setDrawerOpen(false);
    setEditingPoint(null);
  }, []);

  return (
    <div
      data-testid="priwa-field-map"
      className="relative h-full min-h-[100dvh] w-full overflow-hidden bg-neutral-950"
      onPointerDownCapture={requestDeferredOrientationPermission}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {mapInteraction.mode === "browse" && (
        <div className="priwa-map-control-stack pointer-events-none absolute left-4 z-[55] flex flex-col gap-2 min-[992px]:left-[22.5rem]">
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
          <PriwaBaseLayerControl value={baseLayer} onChange={setBaseLayer} />
          <PriwaOfflineMapControl
            areas={offlineBasemapAreas}
            cacheState={basemapCacheState}
            isSupported={isOfflineBasemapSupported}
            active={isOfflineMapModeActive}
            onToggle={() => setOfflineMapModeActive((current) => !current)}
            onStartSelection={startOfflineAreaSelection}
            onClear={handleClearBasemapArea}
          />
          {additionalMapControl}
          {!!warnkarteOverlay?.features.length && warnkarteVisible && (
            <PriwaWarnkarteZoomControl onZoom={zoomToWarnkarte} />
          )}
          {isMobile && (
            <PriwaMobileFieldTools
              points={points}
              groups={groups}
              onEditPoint={openPointForEditing}
              onZoomToPoint={focusPointOnMap}
            />
          )}
          {!isMobile && !isPointListOpen && !isDrawerOpen && (
            <Tooltip title="Käferbaum aufnehmen">
              <Button
                className="pointer-events-auto shadow-md"
                shape="circle"
                size="large"
                icon={<PlusOutlined />}
                onClick={openNewPointDrawer}
                aria-label="Punkt aufnehmen"
              />
            </Tooltip>
          )}
        </div>
      )}

      {isMobile &&
        !isDrawerOpen &&
        !isPointListOpen &&
        mapInteraction.mode === "browse" && (
          <FloatButton
            className="priwa-add-point-fab"
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

      {!isMobile && !isPointListOpen && (
        <PriwaReviewWorkbench
          items={reviewItems}
          points={points}
          mosaics={mosaics}
          selectedKey={selectedReviewKey}
          isLoading={isWorkspaceLoading}
          isSavingGroup={isSavingGroup}
          isClassifyingFlight={isClassifyingFlight}
          enabledMosaicIds={enabledMosaicIds}
          selectedTreeId={reviewPointId}
          isTreeEditing={isReviewTreeEditing}
          isHidden={mapInteraction.mode !== "browse"}
          detailMode={reviewDetailMode}
          onSelect={selectReviewItem}
          onOpenData={() => {
            setReviewPointId(null);
            setFocusedPointId(null);
            setPointListOpen(true);
          }}
          onCreateGroup={() => {
            setReviewPointId(null);
            createGroup();
          }}
          onSelectTree={selectReviewPoint}
          onFocusTree={focusSelectedReviewPoint}
          onEditTree={openReviewPointForEditing}
          onCloseTree={closeReviewTree}
          onEditGroup={setGroupEditorDraft}
          onSaveGroup={saveGroup}
          onAssignFlight={assignFlight}
          onSetMosaicVisibility={setMosaicVisibility}
          onSetFlightType={setFlightType}
          onCreateGroupForFlight={createGroupForFlight}
        />
      )}

      {isPointListOpen && mapInteraction.mode === "browse" && (
        <PriwaPointListPanel
          points={points}
          groups={groups}
          mosaics={mosaics}
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

      {mapInteraction.isPlacingPoint && (
        <div className="pointer-events-none absolute inset-0 z-[70]">
          <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2">
            <div className="absolute left-1/2 top-0 h-12 border-l-2 border-white drop-shadow" />
            <div className="absolute left-0 top-1/2 w-12 border-t-2 border-white drop-shadow" />
            <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-600 bg-white/80" />
          </div>
          <div className="pointer-events-auto absolute bottom-4 left-4 right-4 flex gap-2 rounded-md bg-white/95 p-2 shadow-lg backdrop-blur min-[992px]:bottom-5">
            <Button block onClick={cancelMapPlacement}>
              Abbrechen
            </Button>
            <Button block type="primary" onClick={acceptMapPlacement}>
              Punkt übernehmen
            </Button>
          </div>
        </div>
      )}

      {mapInteraction.isSelectingOfflineArea && (
        <PriwaOfflineAreaSelection
          plan={offlineSelectionPlan}
          cacheState={basemapCacheState}
          onCancel={() => setMode("browse")}
          onConfirm={handleCacheBasemapArea}
        />
      )}

      {mapInteraction.mode === "browse" && (
        <div className="priwa-map-status-stack pointer-events-none absolute right-4 z-[55] flex max-w-[calc(100%-5.75rem)] flex-col items-end gap-1.5 min-[992px]:right-[24.5rem]">
          {locationHintLabel && (
            <div className="rounded-md bg-white/90 px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm backdrop-blur">
              {locationHintLabel}
            </div>
          )}
          <PriwaOfflineStatus syncSummary={syncSummary} onSyncNow={onSyncNow} />
        </div>
      )}

      {dataErrorMessage && mapInteraction.mode === "browse" && (
        <Alert
          className="absolute bottom-20 left-4 right-4 z-[55] shadow-lg min-[992px]:left-auto min-[992px]:w-96"
          type="error"
          showIcon
          message="PRIWA Daten konnten nicht geladen werden"
          description={dataErrorMessage}
        />
      )}

      <PriwaPointDrawer
        key={formSessionId}
        isMobile={isMobile}
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
        presentation={isReviewTreeEditing ? "embedded" : "overlay"}
      />

      <PriwaBefallsgruppeEditor
        open={groupEditorDraft !== null}
        isMobile={isMobile}
        draft={groupEditorDraft}
        points={points}
        mosaics={mosaics.filter((mosaic) => mosaic.flightType !== "not_priwa")}
        groups={groups}
        isSaving={isSavingGroup}
        onClose={() => setGroupEditorDraft(null)}
        onSave={saveGroup}
        onDelete={deleteGroup}
      />
    </div>
  );
}
