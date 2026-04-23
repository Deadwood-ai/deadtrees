import { Button, Spin, message, Drawer } from "antd";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeftOutlined, MenuFoldOutlined, MenuUnfoldOutlined, InfoCircleOutlined, SlidersOutlined } from "@ant-design/icons";
import { useState, useCallback, Suspense, lazy, useEffect } from "react";

import { usePublicDatasetById } from "../hooks/useDatasets";
import { useDatasetLabels } from "../hooks/useDatasetLabels";
import { useModelVariantLabels } from "../hooks/useModelVariantLabels";
import { ILabelData } from "../types/labels";
import { useDownload } from "../hooks/useDownloadProvider";
import { useOverlappingDatasets } from "../hooks/useOverlappingDatasets";
import { useDatasetDetailsMap } from "../hooks/useDatasetDetailsMapProvider";
import { usePhenologyData } from "../hooks/usePhenologyData";
import { useAuth } from "../hooks/useAuthProvider";
import { useCreateFlag } from "../hooks/useDatasetFlags";
import { useDatasetEditing } from "../hooks/useDatasetEditing";
import { useCanAudit } from "../hooks/useUserPrivileges";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAnalytics } from "../hooks/useAnalytics";

import DatasetLayerControlPanel from "../components/DatasetDetailsMap/DatasetLayerControlPanel";
import EditingSidebar from "../components/DatasetDetailsMap/EditingSidebar";
import DatasetInfoSidebar from "../components/DatasetDetailsMap/DatasetInfoSidebar";
import DownloadSection from "../components/DatasetDetailsMap/DownloadSection";
import ReportIssueModal from "../components/DatasetDetailsMap/ReportIssueModal";
import { EditorToolbar } from "../components/PolygonEditor";

const DatasetDetailsMap = lazy(() => import("../components/DatasetDetailsMap/DatasetDetailsMap"));

export default function DatasetDetails() {
  const navigate = useNavigate();
  const { id } = useParams();
  const datasetId = id ? Number(id) : undefined;
  const hasValidDatasetId = typeof datasetId === "number" && Number.isFinite(datasetId);
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  const { track } = useAnalytics("dataset_detail");
  const { data: dataset, isLoading: isDatasetLoading } = usePublicDatasetById(hasValidDatasetId ? datasetId : undefined);
  const {
    setViewport,
    setNavigationSource,
    navigatedFrom,
    layerControl,
    setMapStyle,
    setShowForestCover,
    setShowDeadwood,
    setShowDroneImagery,
    setShowAOI,
    setLayerOpacity,
  } = useDatasetDetailsMap();

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [labelsOnly, setLabelsOnly] = useState(false);
  const isMobile = useIsMobile();

  // Mobile drawers state
  const [mobileInfoDrawerOpen, setMobileInfoDrawerOpen] = useState(false);
  const [mobileControlsDrawerOpen, setMobileControlsDrawerOpen] = useState(false);

  // Report modal state
  const [isReportModalOpen, setReportModalOpen] = useState(false);
  const { mutateAsync: createFlag, isPending: isCreatingFlag } = useCreateFlag();

  // Download state
  const { isDownloading, startDownload, finishDownload, currentDownloadId } = useDownload();

  // Editing hook
  const editing = useDatasetEditing({ datasetId: dataset?.id, user });

  // Data hooks
  const { data: overlappingDatasets, isLoading: isLoadingOverlapping } = useOverlappingDatasets(dataset?.id);
  const { data: labelsData } = useDatasetLabels({
    datasetId: dataset?.id || 0,
    labelData: ILabelData.DEADWOOD,
    enabled: !!dataset?.id,
  });
  const { data: phenologyData, isLoading: isPhenologyLoading } = usePhenologyData(dataset?.id);

  // Auditor model variant selection (session-only, no DB writes)
  const { data: deadwoodVariants } = useModelVariantLabels(dataset?.id, ILabelData.DEADWOOD, canAudit && !!dataset?.id);
  const { data: forestVariants } = useModelVariantLabels(dataset?.id, ILabelData.FOREST_COVER, canAudit && !!dataset?.id);
  const [selectedDeadwoodLabelId, setSelectedDeadwoodLabelId] = useState<number | null>(null);
  const [selectedForestLabelId, setSelectedForestLabelId] = useState<number | null>(null);
  const auditInfo = dataset
    ? {
      final_assessment: dataset.final_assessment,
      forest_cover_quality: dataset.forest_cover_quality,
      deadwood_quality: dataset.deadwood_quality,
      has_valid_phenology: dataset.has_valid_phenology ?? null,
      has_valid_acquisition_date: dataset.has_valid_acquisition_date ?? null,
      audit_date: dataset.audit_date ?? null,
    }
    : null;

  // Back button handler
  const handleBackClick = useCallback(() => {
    setViewport({ center: [0, 0], zoom: 2 });
    setNavigationSource(null);
    if (navigatedFrom === "navigation") {
      navigate("/dataset");
    } else {
      navigate(-1);
    }
  }, [setViewport, setNavigationSource, navigatedFrom, navigate]);

  // Report submit handler
  const handleReportSubmit = useCallback(
    async (values: { is_ortho_mosaic_issue: boolean; is_prediction_issue: boolean; description: string }) => {
      if (!dataset) return;
      await createFlag({ dataset_id: dataset.id, ...values });
      track("flag_submitted", {
        dataset_id: dataset.id,
        flag_type:
          values.is_ortho_mosaic_issue && values.is_prediction_issue
            ? "mixed"
            : values.is_ortho_mosaic_issue
              ? "orthomosaic"
              : "prediction",
      });
      message.success("Issue reported successfully");
      setReportModalOpen(false);
    },
    [dataset, createFlag, track]
  );

  useEffect(() => {
    if (dataset?.data_access === "viewonly" && !labelsOnly) {
      setLabelsOnly(true);
    }
  }, [dataset?.data_access, labelsOnly, setLabelsOnly]);

  useEffect(() => {
    if (!dataset) return;
    track("dataset_opened", { dataset_id: dataset.id });
    if (dataset.is_deadwood_done || dataset.is_forest_cover_done) {
      track("processing_result_viewed", {
        dataset_id: dataset.id,
        processing_type: dataset.is_deadwood_done && dataset.is_forest_cover_done
          ? "deadwood_and_forest_cover"
          : dataset.is_deadwood_done
            ? "deadwood"
            : "forest_cover",
      });
    }
  }, [dataset, track]);

  // Loading state
  if (!hasValidDatasetId || isDatasetLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center" style={{ minHeight: "60vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4" style={{ minHeight: "60vh" }}>
        <div className="text-center text-slate-600">
          <p className="mb-3 text-base font-medium">Dataset not found.</p>
          <Button onClick={() => navigate("/dataset")}>Back to datasets</Button>
        </div>
      </div>
    );
  }

  const { isEditing, editingLayerType, editor, ai, hasDeadwood, hasForestCover, refreshKey } = editing;
  const SIDEBAR_LEFT_PX = 16;
  const SIDEBAR_WIDTH_PX = 384;
  const SIDEBAR_BUTTON_TOP_PX = 112;
  const FLOAT_BUTTON_SIZE_PX = 36;
  const TOGGLE_INSET_EXPANDED_PX = 24;

  const sidebarContent = (
    <div className={`flex-1 overflow-y-auto ${isMobile ? "p-4" : "p-4 pr-5 pt-20"}`}>
      {isEditing && editingLayerType ? (
        <EditingSidebar layerType={editingLayerType} />
      ) : (
        <DatasetInfoSidebar
          dataset={dataset}
          phenologyData={phenologyData}
          isPhenologyLoading={isPhenologyLoading}
          auditInfo={auditInfo}
          overlappingDatasets={overlappingDatasets || []}
          isLoadingOverlapping={isLoadingOverlapping}
        />
      )}
    </div>
  );

  const downloadSectionContent = !isEditing && (
    <div className="shrink-0 border-t border-slate-300/90 bg-slate-100/95 px-4 pb-4 pt-3 shadow-[0_-10px_24px_rgba(15,23,42,0.12)] backdrop-blur-sm">
      <DownloadSection
        dataset={dataset}
        labelsOnly={labelsOnly}
        setLabelsOnly={setLabelsOnly}
        hasLabels={!!labelsData}
        isDownloading={isDownloading}
        currentDownloadId={currentDownloadId}
        startDownload={startDownload}
        finishDownload={finishDownload}
      />
    </div>
  );

  return (
    <div className="relative h-full w-full bg-slate-50 overflow-hidden">
      {/* Collapsible Sidebar (Desktop) */}
      <div
        className={`hidden md:flex absolute left-4 top-24 bottom-6 z-10 flex-col rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm pointer-events-auto transition-all duration-300 ${sidebarCollapsed ? "w-0 overflow-hidden opacity-0 pointer-events-none -translate-x-full" : "w-96 opacity-100 translate-x-0"
          }`}
      >
        {sidebarContent}
        {downloadSectionContent}
      </div>

      {/* Mobile Top Controls (Back + Actions) */}
      <div className="absolute left-2 right-2 top-20 z-50 flex items-center justify-between pointer-events-none md:hidden">
        {/* Left side: Back Button */}
        <div className="pointer-events-auto">
          {!isEditing && (
             <Button shape="circle" onClick={handleBackClick} icon={<ArrowLeftOutlined />} className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900" />
          )}
        </div>
        
        {/* Right side: Details & Controls */}
        <div className="flex items-center gap-2 pointer-events-auto">
          <Button
            icon={<InfoCircleOutlined />}
            className="shadow-sm"
            onClick={() => setMobileInfoDrawerOpen(true)}
          >
            Details
          </Button>
          <Button
            icon={<SlidersOutlined />}
            className="shadow-sm"
            onClick={() => setMobileControlsDrawerOpen(true)}
          >
            Controls
          </Button>
        </div>
      </div>

      {/* Back Button - hidden when editing */}
      {!isEditing && !isMobile && (
        <div
          className="absolute z-20 transition-all duration-300 hidden md:block"
          style={{ top: `${SIDEBAR_BUTTON_TOP_PX}px`, left: sidebarCollapsed ? `${SIDEBAR_LEFT_PX}px` : `${SIDEBAR_LEFT_PX + 12}px` }}
        >
          <Button size="large" shape="circle" onClick={handleBackClick} icon={<ArrowLeftOutlined />} className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900" />
        </div>
      )}

      {/* Sidebar Toggle */}
      {!isMobile && (
        <div
          className="absolute z-20 transition-all duration-300 hidden md:block"
          style={{
            top: `${SIDEBAR_BUTTON_TOP_PX}px`,
            left: sidebarCollapsed
              ? `${SIDEBAR_LEFT_PX + 56}px`
              : `${SIDEBAR_LEFT_PX + SIDEBAR_WIDTH_PX - FLOAT_BUTTON_SIZE_PX - TOGGLE_INSET_EXPANDED_PX}px`,
          }}
        >
          <Button
            size="large"
            shape="circle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900"
          />
        </div>
      )}

      {/* Map Column */}
      <div className="absolute inset-0 z-0">
        {/* Layer Control Panel - hidden when editing on desktop */}
        {!isEditing && (
          <div className="absolute right-4 top-24 z-10 hidden md:block">
            <DatasetLayerControlPanel
              mapStyle={layerControl.mapStyle}
              onMapStyleChange={setMapStyle}
              showForestCover={layerControl.showForestCover}
              setShowForestCover={setShowForestCover}
              showDeadwood={layerControl.showDeadwood}
              setShowDeadwood={setShowDeadwood}
              showDroneImagery={layerControl.showDroneImagery}
              setShowDroneImagery={setShowDroneImagery}
              showAOI={layerControl.showAOI}
              setShowAOI={setShowAOI}
              hasForestCover={hasForestCover && !!dataset.is_forest_cover_done}
              hasDeadwood={hasDeadwood}
              hasAOI={true}
              forestCoverQuality={auditInfo?.forest_cover_quality as "great" | "sentinel_ok" | "bad" | undefined}
              deadwoodQuality={auditInfo?.deadwood_quality as "great" | "sentinel_ok" | "bad" | undefined}
              canBypassQualityRestriction={canAudit}
              canAudit={canAudit}
              deadwoodVariants={deadwoodVariants ?? []}
              forestVariants={forestVariants ?? []}
              selectedDeadwoodLabelId={selectedDeadwoodLabelId}
              onDeadwoodVariantChange={setSelectedDeadwoodLabelId}
              selectedForestLabelId={selectedForestLabelId}
              onForestVariantChange={setSelectedForestLabelId}
              opacity={layerControl.layerOpacity}
              setOpacity={setLayerOpacity}
              onReportClick={() => setReportModalOpen(true)}
              onEditForestCover={() => editing.handleStartEditing("forest_cover")}
              onEditDeadwood={() => editing.handleStartEditing("deadwood")}
              isLoggedIn={!!user}
            />
          </div>
        )}

        {/* Editor Toolbar - visible when editing */}
        {isEditing && (
          <EditorToolbar
            type={editingLayerType || "deadwood"}
            isDrawing={editor.isDrawing}
            hasSelection={editor.selection.length > 0}
            selectionCount={editor.selection.length}
            isAIActive={ai.isActive}
            isAIProcessing={ai.isProcessing}
            onToggleDraw={() => editor.toggleDraw()}
            onCutHole={editor.cutHoleWithDrawn}
            onMerge={editor.mergeSelected}
            onClip={editor.clipSelected}
            onToggleAI={() => (ai.isActive ? ai.disable() : ai.enable())}
            onDeleteSelected={editor.deleteSelected}
            onUndo={editor.undo}
            canUndo={editor.canUndo}
            onSave={editing.handleSaveEdits}
            onCancel={editing.handleCancelEditing}
            position="top-right"
            title={`Editing ${editingLayerType === "deadwood" ? "Deadwood" : "Forest Cover"}`}
          />
        )}

        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center bg-slate-50">
              <Spin size="large" />
            </div>
          }
        >
          <DatasetDetailsMap
            data={dataset}
            onMapReady={editing.handleMapReady}
            onOrthoLayerReady={editing.handleOrthoLayerReady}
            onFirstMapInteraction={() =>
              track("dataset_map_interacted", {
                dataset_id: dataset.id,
                interaction_type: "move",
              })
            }
            hideDeadwoodLayer={isEditing}
            hideForestCoverLayer={isEditing}
            refreshKey={refreshKey}
            showDeadwood={isEditing ? false : layerControl.showDeadwood}
            showForestCover={isEditing ? false : layerControl.showForestCover}
            showDroneImagery={layerControl.showDroneImagery}
            showAOI={layerControl.showAOI}
            layerOpacity={layerControl.layerOpacity}
            onEditDeadwood={() => editing.handleStartEditing("deadwood")}
            onEditForestCover={() => editing.handleStartEditing("forest_cover")}
            isLoggedIn={!!user}
            allowBadQualityLayers={canAudit}
            deadwoodLabelIdOverride={canAudit && selectedDeadwoodLabelId !== null ? selectedDeadwoodLabelId : undefined}
            forestCoverLabelIdOverride={canAudit && selectedForestLabelId !== null ? selectedForestLabelId : undefined}
          />
        </Suspense>
      </div>

      <Drawer
        title="Dataset Details"
        placement="bottom"
        height="85vh"
        open={mobileInfoDrawerOpen}
        onClose={() => setMobileInfoDrawerOpen(false)}
        className="md:hidden"
        styles={{ body: { padding: '0', display: 'flex', flexDirection: 'column' } }}
      >
        {sidebarContent}
        {downloadSectionContent}
      </Drawer>

      <Drawer
        title="Map controls"
        placement="bottom"
        height="auto"
        open={mobileControlsDrawerOpen}
        onClose={() => setMobileControlsDrawerOpen(false)}
        className="md:hidden"
        styles={{ body: { padding: '16px', overflowY: 'auto' } }}
      >
        <div className="flex justify-center w-full pb-8">
          <DatasetLayerControlPanel
            mapStyle={layerControl.mapStyle}
            onMapStyleChange={setMapStyle}
            showForestCover={layerControl.showForestCover}
            setShowForestCover={setShowForestCover}
            showDeadwood={layerControl.showDeadwood}
            setShowDeadwood={setShowDeadwood}
            showDroneImagery={layerControl.showDroneImagery}
            setShowDroneImagery={setShowDroneImagery}
            showAOI={layerControl.showAOI}
            setShowAOI={setShowAOI}
            hasForestCover={hasForestCover && !!dataset.is_forest_cover_done}
            hasDeadwood={hasDeadwood}
            hasAOI={true}
            forestCoverQuality={auditInfo?.forest_cover_quality as "great" | "sentinel_ok" | "bad" | undefined}
            deadwoodQuality={auditInfo?.deadwood_quality as "great" | "sentinel_ok" | "bad" | undefined}
            canBypassQualityRestriction={canAudit}
            canAudit={canAudit}
            deadwoodVariants={deadwoodVariants ?? []}
            forestVariants={forestVariants ?? []}
            selectedDeadwoodLabelId={selectedDeadwoodLabelId}
            onDeadwoodVariantChange={setSelectedDeadwoodLabelId}
            selectedForestLabelId={selectedForestLabelId}
            onForestVariantChange={setSelectedForestLabelId}
            opacity={layerControl.layerOpacity}
            setOpacity={setLayerOpacity}
            onReportClick={() => setReportModalOpen(true)}
            onEditForestCover={() => editing.handleStartEditing("forest_cover")}
            onEditDeadwood={() => editing.handleStartEditing("deadwood")}
            isLoggedIn={!!user}
          />
        </div>
      </Drawer>

      {/* Report Issue Modal */}
      <ReportIssueModal
        open={isReportModalOpen}
        onCancel={() => setReportModalOpen(false)}
        onSubmit={handleReportSubmit}
        isSubmitting={isCreatingFlag}
      />
    </div>
  );
}
