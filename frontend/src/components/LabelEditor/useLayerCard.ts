import { useCallback, useEffect, useState } from "react";
import { mapColors } from "../../theme/mapColors";
import type {
  Background,
  LayerCardProps,
  EditableLayer,
  LayerCardRow,
  LayerView,
} from "./LayerCard";
import { useLayerCardKeys } from "./useLayerCardKeys";

interface LayerVisibility {
  showDeadwood: boolean;
  showForestCover: boolean;
  showAOI: boolean;
  layerOpacity: number;
  mapStyle: string;
}

interface UseLayerCardParams {
  enabled: boolean;
  layers: LayerVisibility;
  setShowDeadwood: (show: boolean) => void;
  setShowForestCover: (show: boolean) => void;
  setShowAOI: (show: boolean) => void;
  setLayerOpacity: (value: number) => void;
  setMapStyle: (style: string) => void;
  hasDeadwood: boolean;
  hasForestCover: boolean;
  /** A layer rated "bad" stays hidden for people who cannot audit. */
  deadwoodBlocked: boolean;
  forestBlocked: boolean;
  hasAOI: boolean;
  canEdit: boolean;
  isEditing: boolean;
  editingLayer: EditableLayer | null;
  startEditing: (layer: EditableLayer) => void;
  switchEditLayer: (layer: EditableLayer) => void;
  /** Shows or hides the layer being edited while Space is held. */
  setEditOverlayVisible: (visible: boolean) => void;
}

// Basemap styles of the dataset map (useBaseLayers): OpenFreeMap streets or Esri Wayback satellite.
const MAP_STYLE = "streets-v12";
const SATELLITE_STYLE = "satellite-streets-v12";

function viewOf(deadwood: boolean, forest: boolean): LayerView {
  if (deadwood && forest) return "both";
  if (deadwood) return "deadwood";
  if (forest) return "forest_cover";
  return "imagery";
}

/**
 * State and keys behind the dataset map's layer card. Exploring, the card picks what the map
 * shows; editing, it picks the layer you edit. Holding Space hides labels in both modes.
 */
export function useLayerCard(p: UseLayerCardParams) {
  const [peek, setPeek] = useState(false);
  const deadwoodOk = p.hasDeadwood && !p.deadwoodBlocked;
  const forestOk = p.hasForestCover && !p.forestBlocked;
  const view = viewOf(
    p.layers.showDeadwood && deadwoodOk,
    p.layers.showForestCover && forestOk,
  );

  const { setShowDeadwood, setShowForestCover } = p;
  const setView = useCallback(
    (next: LayerView) => {
      const wantsDeadwood = next === "deadwood" || next === "both";
      const wantsForest = next === "forest_cover" || next === "both";
      if ((wantsDeadwood && !deadwoodOk) || (wantsForest && !forestOk)) return;
      setShowDeadwood(wantsDeadwood);
      setShowForestCover(wantsForest);
    },
    [deadwoodOk, forestOk, setShowDeadwood, setShowForestCover],
  );

  const editTarget: EditableLayer | null = !p.canEdit
    ? null
    : view === "forest_cover" && p.hasForestCover
      ? "forest_cover"
      : p.hasDeadwood
        ? "deadwood"
        : p.hasForestCover
          ? "forest_cover"
          : null;

  const { startEditing, isEditing, setEditOverlayVisible } = p;
  const startEdit = useCallback(() => {
    if (editTarget) startEditing(editTarget);
  }, [editTarget, startEditing]);

  useEffect(() => {
    if (isEditing) setEditOverlayVisible(!peek);
  }, [isEditing, peek, setEditOverlayVisible]);

  const background: Background =
    p.layers.mapStyle === SATELLITE_STYLE ? "satellite" : "map";
  const { setMapStyle } = p;
  const setBackground = useCallback(
    (next: Background) =>
      setMapStyle(next === "satellite" ? SATELLITE_STYLE : MAP_STYLE),
    [setMapStyle],
  );

  useLayerCardKeys({
    enabled: p.enabled,
    isEditing,
    onView: setView,
    onStartEdit: startEdit,
    onToggleBackground: () =>
      setBackground(background === "satellite" ? "map" : "satellite"),
    onPeek: setPeek,
  });

  const unavailable = (has: boolean, blocked: boolean, name: string) =>
    !has
      ? `This dataset has no ${name} prediction.`
      : blocked
        ? `The ${name} prediction did not pass the audit.`
        : undefined;
  const rows: LayerCardRow[] = [
    { view: "imagery", key: "1", label: "No labels", swatch: null },
    {
      view: "deadwood",
      key: "2",
      label: "Deadwood",
      swatch: mapColors.deadwood.fill,
      disabledReason: unavailable(p.hasDeadwood, p.deadwoodBlocked, "deadwood"),
    },
    {
      view: "forest_cover",
      key: "3",
      label: "Tree cover",
      swatch: mapColors.forest.fill,
      disabledReason: unavailable(
        p.hasForestCover,
        p.forestBlocked,
        "tree cover",
      ),
    },
    {
      view: "both",
      key: "4",
      label: "Both",
      swatch: `linear-gradient(135deg, ${mapColors.deadwood.fill} 50%, ${mapColors.forest.fill} 50%)`,
      disabledReason:
        !deadwoodOk || !forestOk ? "Needs both predictions." : undefined,
    },
  ];

  const cardProps: LayerCardProps = {
    rows,
    view,
    onViewChange: setView,
    opacity: p.layers.layerOpacity,
    onOpacityChange: p.setLayerOpacity,
    background,
    onBackgroundChange: setBackground,
    hasAOI: p.hasAOI,
    showAOI: p.layers.showAOI,
    onShowAOIChange: p.setShowAOI,
    editingLayer: isEditing ? p.editingLayer : null,
    onEditLayer: p.switchEditLayer,
    editTarget,
    onStartEdit: startEdit,
  };

  return { cardProps, peek };
}
