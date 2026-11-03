import { useCallback, useEffect, useRef } from "react";
import { Button } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { IDataset } from "../types/dataset";
import { useAuth } from "../hooks/useAuthProvider";
import { useCanAudit } from "../hooks/useUserPrivileges";
import { useDatasetDetailsMap } from "../hooks/useDatasetDetailsMapProvider";
import { useDatasetEditing } from "../hooks/useDatasetEditing";
import { useDatasetAOI } from "../hooks/useDatasetAudit";
import { hasForestCoverPredictionOutput } from "../utils/predictionAvailability";
import DatasetDetailsMap from "../components/DatasetDetailsMap/DatasetDetailsMap";
import { useSidebarCollapse } from "../components/DatasetDetailsMap/hooks/useSidebarCollapse";
import LayerCard, {
  type EditableLayer,
} from "../components/LabelEditor/LayerCard";
import { useLayerCard } from "../components/LabelEditor/useLayerCard";
import LabelEditorHelp from "../components/LabelEditor/LabelEditorHelp";
import EditingToolbar from "../components/LabelEditor/EditingToolbar";

interface DatasetLabelEditorViewProps {
  dataset: IDataset;
}

/**
 * The label editor of one dataset. It opens in explore mode (switch layers, inspect polygons,
 * no toolbar); E or "Edit" starts edit mode on a layer, and Save or Cancel returns to explore.
 */
export default function DatasetLabelEditorView({
  dataset,
}: DatasetLabelEditorViewProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  const {
    layerControl,
    setShowDeadwood,
    setShowForestCover,
    setShowAOI,
    setLayerOpacity,
    setMapStyle,
  } = useDatasetDetailsMap();
  const editing = useDatasetEditing({ datasetId: dataset.id, user });
  const {
    isEditing,
    editingLayerType,
    editor,
    hasDeadwood,
    hasForestCover,
    refreshKey,
  } = editing;
  const { data: aoiData } = useDatasetAOI(dataset.id);
  const help = useSidebarCollapse("dt-label-editor-help-collapsed", true);

  const setEditOverlayVisible = useCallback(
    (visible: boolean) => editor.getOverlayLayer()?.setVisible(visible),
    [editor],
  );
  const { cardProps, peek } = useLayerCard({
    enabled: true,
    layers: layerControl,
    setShowDeadwood,
    setShowForestCover,
    setShowAOI,
    setLayerOpacity,
    setMapStyle,
    hasDeadwood,
    hasForestCover: hasForestCover && hasForestCoverPredictionOutput(dataset),
    deadwoodBlocked: dataset.deadwood_quality === "bad" && !canAudit,
    forestBlocked: dataset.forest_cover_quality === "bad" && !canAudit,
    hasAOI: !!aoiData?.geometry,
    canEdit: !!user,
    isEditing,
    editingLayer: editingLayerType,
    startEditing: editing.handleStartEditing,
    switchEditLayer: (layer) => void editing.switchLayer(layer),
    setEditOverlayVisible,
  });

  // A link from the details page can name the layer to look at first (?layer=deadwood).
  const appliedLayerParam = useRef(false);
  const setView = cardProps.onViewChange;
  useEffect(() => {
    if (appliedLayerParam.current) return;
    const layer = searchParams.get("layer") as EditableLayer | null;
    if (layer !== "deadwood" && layer !== "forest_cover") return;
    if (layer === "deadwood" ? !hasDeadwood : !hasForestCover) return;
    appliedLayerParam.current = true;
    setView(layer);
  }, [searchParams, hasDeadwood, hasForestCover, setView]);

  const close = () => navigate(`/dataset/${dataset.id}`);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-slate-50"
      data-testid="label-editor-page"
    >
      <div className="absolute inset-0 z-0">
        <DatasetDetailsMap
          data={dataset}
          onMapReady={editing.handleMapReady}
          onOrthoLayerReady={editing.handleOrthoLayerReady}
          hideDeadwoodLayer={isEditing}
          hideForestCoverLayer={isEditing}
          refreshKey={refreshKey}
          showDeadwood={!isEditing && !peek && layerControl.showDeadwood}
          showForestCover={!isEditing && !peek && layerControl.showForestCover}
          showDroneImagery={layerControl.showDroneImagery}
          showAOI={layerControl.showAOI}
          layerOpacity={layerControl.layerOpacity}
          onEditDeadwood={() => editing.handleStartEditing("deadwood")}
          onEditForestCover={() => editing.handleStartEditing("forest_cover")}
          isLoggedIn={!!user}
          allowBadQualityLayers={canAudit}
        />
      </div>

      <div className="pointer-events-none absolute left-4 top-24 z-20 flex flex-col items-start gap-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white/95 py-1.5 pl-1.5 pr-3 shadow-md">
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={close}
            disabled={isEditing}
            title={
              isEditing
                ? "Save or cancel your edits first"
                : "Back to the dataset page"
            }
            aria-label="Back to the dataset page"
          />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-gray-800">
              Label editor
            </span>
            <span className="text-xs text-gray-500">Dataset {dataset.id}</span>
          </div>
          <span
            className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
              isEditing
                ? "bg-amber-100 text-amber-800"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {isEditing ? "Editing" : "Exploring"}
          </span>
        </div>
        <div className="pointer-events-auto">
          <LabelEditorHelp
            collapsed={help.collapsed}
            onToggle={help.toggle}
            isEditing={isEditing}
          />
        </div>
      </div>

      {isEditing && <EditingToolbar editing={editing} />}

      <div className="absolute bottom-6 left-4 z-20">
        <LayerCard {...cardProps} />
      </div>
    </div>
  );
}
