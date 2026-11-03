import { Button, message, Drawer } from "antd";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Map as OLMap } from "ol";
import {
  ArrowLeftOutlined,
  LeftOutlined,
  RightOutlined,
  InfoCircleOutlined,
  SlidersOutlined,
} from "@ant-design/icons";
import { useState, useCallback, useEffect } from "react";

import type { IDataset } from "../types/dataset";
import { useDatasetLabels } from "../hooks/useDatasetLabels";
import { useModelVariantLabels } from "../hooks/useModelVariantLabels";
import { ILabelData, ILabelSource } from "../types/labels";
import { useDownload } from "../hooks/useDownloadProvider";
import { useOverlappingDatasets } from "../hooks/useOverlappingDatasets";
import { useDatasetDetailsMap } from "../hooks/useDatasetDetailsMapProvider";
import { usePhenologyData } from "../hooks/usePhenologyData";
import { useAuth } from "../hooks/useAuthProvider";
import { useCreateFlag } from "../hooks/useDatasetFlags";
import { useDatasetLabelTypes } from "../hooks/useDatasetLabelTypes";
import { useDatasetAOI } from "../hooks/useDatasetAudit";
import { useCanAudit } from "../hooks/useUserPrivileges";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAnalytics } from "../hooks/useAnalytics";
import { hasForestCoverPredictionOutput } from "../utils/predictionAvailability";
import { observeOwnedResult } from "../utils/observeOwnedResult";

import DatasetLayerControlPanel from "../components/DatasetDetailsMap/DatasetLayerControlPanel";
import { useSidebarCollapse } from "../components/DatasetDetailsMap/hooks/useSidebarCollapse";
import DatasetInfoSidebar from "../components/DatasetDetailsMap/DatasetInfoSidebar";
import DownloadSection from "../components/DatasetDetailsMap/DownloadSection";
import ReportIssueModal from "../components/DatasetDetailsMap/ReportIssueModal";
import OrthoTileSearch from "../components/DatasetDetailsMap/OrthoTileSearch";
import { hasMapImage } from "../utils/datasetFileUrls";

import DatasetDetailsMap from "../components/DatasetDetailsMap/DatasetDetailsMap";

interface DatasetDetailsViewProps {
  dataset: IDataset;
}

// DatasetDetails owns loading, not-found and error states; this view only
// renders a dataset that loaded.
export default function DatasetDetailsView({ dataset }: DatasetDetailsViewProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Open-vocabulary query forwarded from the dataset list (highlights tiles).
  const initialTileQuery = searchParams.get("q");
  // OL map instance, captured so the tile-search overlay can draw highlights.
  const [mapInstance, setMapInstance] = useState<OLMap | null>(null);
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  const { track } = useAnalytics("dataset_detail");
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

  const [labelsOnly, setLabelsOnly] = useState(false);
  const isMobile = useIsMobile("lg");

  // Mobile drawers state
  const [mobileInfoDrawerOpen, setMobileInfoDrawerOpen] = useState(false);
  const [mobileControlsDrawerOpen, setMobileControlsDrawerOpen] =
    useState(false);

  // Report modal state
  const [isReportModalOpen, setReportModalOpen] = useState(false);
  const { mutateAsync: createFlag, isPending: isCreatingFlag } =
    useCreateFlag();

  // Download state
  const { isDownloading, startDownload, finishDownload, currentDownloadId } =
    useDownload();

  const { deadwood: deadwoodLabelType, forestCover: forestLabelType } = useDatasetLabelTypes({
    datasetId: dataset?.id,
    enabled: !!dataset?.id,
  });
  const openEditor = useCallback(
    (layer?: "deadwood" | "forest_cover") =>
      navigate(`/dataset/${dataset.id}/edit${layer ? `?layer=${layer}` : ""}`),
    [navigate, dataset.id],
  );

  // AOI presence drives whether the Area of Interest layer toggle is shown
  const { data: aoiData } = useDatasetAOI(dataset?.id);

  // Data hooks
  const { data: overlappingDatasets, isLoading: isLoadingOverlapping } =
    useOverlappingDatasets(dataset?.id);
  const { data: preferredDeadwoodLabel } = useDatasetLabels({
    datasetId: dataset?.id || 0,
    labelData: ILabelData.DEADWOOD,
    enabled: !!dataset?.id,
  });
  const { data: preferredForestLabel } = useDatasetLabels({
    datasetId: dataset?.id || 0,
    labelData: ILabelData.FOREST_COVER,
    enabled: !!dataset?.id,
  });
  const { data: phenologyData, isLoading: isPhenologyLoading } =
    usePhenologyData(dataset?.id);

  // Auditor model variant selection (session-only, no DB writes)
  const { data: deadwoodVariants } = useModelVariantLabels(
    dataset?.id,
    ILabelData.DEADWOOD,
    canAudit && !!dataset?.id,
  );
  const { data: forestVariants } = useModelVariantLabels(
    dataset?.id,
    ILabelData.FOREST_COVER,
    canAudit && !!dataset?.id,
  );
  const [selectedDeadwoodLabelId, setSelectedDeadwoodLabelId] = useState<
    number | null
  >(null);
  const [selectedForestLabelId, setSelectedForestLabelId] = useState<
    number | null
  >(null);
  const effectiveSelectedDeadwoodLabelId =
    selectedDeadwoodLabelId ?? preferredDeadwoodLabel?.id ?? null;
  const effectiveSelectedForestLabelId =
    selectedForestLabelId ?? preferredForestLabel?.id ?? null;
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
    async (values: {
      is_ortho_mosaic_issue: boolean;
      is_prediction_issue: boolean;
      description: string;
    }) => {
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
    [dataset, createFlag, track],
  );

  useEffect(() => {
    setLabelsOnly(false);
  }, [dataset?.id]);

  useEffect(() => {
    setSelectedDeadwoodLabelId(null);
    setSelectedForestLabelId(null);
  }, [dataset?.id]);

  useEffect(() => {
    if (!dataset) return;
    track("dataset_opened", { dataset_id: dataset.id });
    if (dataset.is_deadwood_done || dataset.is_forest_cover_done) {
      track("processing_result_viewed", {
        dataset_id: dataset.id,
        processing_type:
          dataset.is_deadwood_done && dataset.is_forest_cover_done
            ? "deadwood_and_forest_cover"
            : dataset.is_deadwood_done
              ? "deadwood"
              : "forest_cover",
      });
    }
  }, [dataset, track]);

  useEffect(() => {
    void observeOwnedResult(dataset, user?.id);
  }, [dataset, user?.id]);

  const hasDeadwood = !!deadwoodLabelType.data?.id;
  const hasForestCover = !!forestLabelType.data?.id;
  const hasDisplayableForestCover =
    hasForestCover && hasForestCoverPredictionOutput(dataset);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse("dt-dataset-sidebar-collapsed");
  const hasExportableLabels = [preferredDeadwoodLabel, preferredForestLabel].some(
    (label) =>
      label?.label_source === ILabelSource.MODEL_PREDICTION ||
      label?.label_source === ILabelSource.VISUAL_INTERPRETATION,
  );
  const hasAOI = !!aoiData?.geometry;
  // Without a viewable image there is no map, so basemap/layer controls and the
  // in-image search would be dead weight next to the empty state.
  const showMapImage = hasMapImage(dataset);
  const SIDEBAR_LEFT_PX = 16;
  const SIDEBAR_WIDTH_PX = 384;
  const SIDEBAR_BUTTON_TOP_PX = 112;

  const sidebarContent = (
    <div
      className={`flex-1 overflow-y-auto ${isMobile ? "p-4" : "p-4 pr-5 pt-20"}`}
    >
      <DatasetInfoSidebar
        dataset={dataset}
        phenologyData={phenologyData}
        isPhenologyLoading={isPhenologyLoading}
        auditInfo={auditInfo}
        overlappingDatasets={overlappingDatasets || []}
        isLoadingOverlapping={isLoadingOverlapping}
      />
      {!showMapImage && canAudit && (
        <Button className="mt-4" onClick={() => navigate(`/dataset-audit/${dataset.id}`)}>
          Audit dataset
        </Button>
      )}
    </div>
  );

  const downloadSectionContent = (
    <div className="shrink-0 border-t border-slate-300/90 bg-slate-100/95 px-4 pb-4 pt-3 shadow-[0_-10px_24px_rgba(15,23,42,0.12)] backdrop-blur-sm">
      <DownloadSection
        dataset={dataset}
        labelsOnly={labelsOnly}
        setLabelsOnly={setLabelsOnly}
        hasExportableLabels={hasExportableLabels}
        isDownloading={isDownloading}
        currentDownloadId={currentDownloadId}
        startDownload={startDownload}
        finishDownload={finishDownload}
      />
    </div>
  );

  return (
    <div
      className="relative h-full w-full bg-slate-50 overflow-hidden"
      data-testid="dataset-detail-page"
    >
      {/* Collapsible Sidebar (Desktop) */}
      <div
        className={`hidden lg:flex absolute left-4 top-24 bottom-6 z-10 flex-col rounded-2xl border border-gray-200/60 bg-white/95 shadow-xl backdrop-blur-sm pointer-events-auto transition-all duration-300 ${
          sidebarCollapsed
            ? "w-0 overflow-hidden opacity-0 pointer-events-none -translate-x-full"
            : "w-96 opacity-100 translate-x-0"
        }`}
      >
        {sidebarContent}
        {downloadSectionContent}
      </div>

      {/* Mobile Top Controls (Back + Actions) */}
      <div className="absolute left-2 right-2 top-20 z-50 flex items-center justify-between pointer-events-none lg:hidden">
        {/* Left side: Back Button */}
        <div className="pointer-events-auto">
          <Button
            data-testid="dataset-detail-back-mobile"
            shape="circle"
            onClick={handleBackClick}
            icon={<ArrowLeftOutlined />}
            className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900"
          />
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
          {showMapImage && (
            <Button
              icon={<SlidersOutlined />}
              className="shadow-sm"
              onClick={() => setMobileControlsDrawerOpen(true)}
            >
              Controls
            </Button>
          )}
        </div>
      </div>

      {/* Back Button */}
      {!isMobile && (
        <div
          className="absolute z-20 transition-all duration-300 hidden lg:block"
          style={{
            top: `${SIDEBAR_BUTTON_TOP_PX}px`,
            left: sidebarCollapsed
              ? `${SIDEBAR_LEFT_PX}px`
              : `${SIDEBAR_LEFT_PX + 12}px`,
          }}
        >
          <Button
            data-testid="dataset-detail-back-desktop"
            size="large"
            shape="circle"
            onClick={handleBackClick}
            icon={<ArrowLeftOutlined />}
            className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900"
          />
        </div>
      )}

      {/* Sidebar collapse: a tab on the panel edge, or a "Details" button when folded (key I) */}
      {!isMobile && (
        <div
          className="absolute z-20 hidden transition-all duration-300 lg:block"
          style={
            sidebarCollapsed
              ? { top: `${SIDEBAR_BUTTON_TOP_PX}px`, left: `${SIDEBAR_LEFT_PX + 56}px` }
              : { top: "50%", left: `${SIDEBAR_LEFT_PX + SIDEBAR_WIDTH_PX - 2}px` }
          }
        >
          {sidebarCollapsed ? (
            <Button
              size="large"
              icon={<RightOutlined />}
              onClick={toggleSidebar}
              title="Show dataset details (I)"
              className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900"
            >
              Details
            </Button>
          ) : (
            <button
              type="button"
              onClick={toggleSidebar}
              title="Hide dataset details (I)"
              aria-label="Hide dataset details"
              className="flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-gray-200 bg-white text-gray-500 shadow-md hover:text-gray-900"
            >
              <LeftOutlined className="text-xs" />
            </button>
          )}
        </div>
      )}

      {/* Map Column */}
      <div className="absolute inset-0 z-0">
        {showMapImage && (
          <div className="absolute right-4 top-24 z-10 hidden lg:block">
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
              hasForestCover={hasDisplayableForestCover}
              hasDeadwood={hasDeadwood}
              hasAOI={hasAOI}
              forestCoverQuality={
                auditInfo?.forest_cover_quality as
                  | "great"
                  | "sentinel_ok"
                  | "bad"
                  | undefined
              }
              deadwoodQuality={
                auditInfo?.deadwood_quality as
                  | "great"
                  | "sentinel_ok"
                  | "bad"
                  | undefined
              }
              canBypassQualityRestriction={canAudit}
              canAudit={canAudit}
              deadwoodVariants={deadwoodVariants ?? []}
              forestVariants={forestVariants ?? []}
              selectedDeadwoodLabelId={effectiveSelectedDeadwoodLabelId}
              onDeadwoodVariantChange={setSelectedDeadwoodLabelId}
              selectedForestLabelId={effectiveSelectedForestLabelId}
              onForestVariantChange={setSelectedForestLabelId}
              opacity={layerControl.layerOpacity}
              setOpacity={setLayerOpacity}
              onReportClick={() => setReportModalOpen(true)}
              onEditLabels={() => openEditor()}
              onAuditClick={dataset ? () => navigate(`/dataset-audit/${dataset.id}`) : undefined}
              isLoggedIn={!!user}
            />
          </div>
        )}

        <DatasetDetailsMap
          data={dataset}
          onMapReady={setMapInstance}
          onFirstMapInteraction={() =>
            track("dataset_map_interacted", {
              dataset_id: dataset.id,
              interaction_type: "move",
            })
          }
          showDeadwood={layerControl.showDeadwood}
          showForestCover={layerControl.showForestCover}
          showDroneImagery={layerControl.showDroneImagery}
          showAOI={layerControl.showAOI}
          layerOpacity={layerControl.layerOpacity}
          onEditDeadwood={() => openEditor("deadwood")}
          onEditForestCover={() => openEditor("forest_cover")}
          isLoggedIn={!!user}
          allowBadQualityLayers={canAudit}
          deadwoodLabelIdOverride={
            canAudit && selectedDeadwoodLabelId !== null
              ? selectedDeadwoodLabelId
              : undefined
          }
          forestCoverLabelIdOverride={
            canAudit && selectedForestLabelId !== null
              ? selectedForestLabelId
              : undefined
          }
        />

        {showMapImage && (
          <div className="pointer-events-none absolute left-1/2 top-[7.5rem] z-30 -translate-x-1/2 lg:top-24">
            <div className="pointer-events-auto">
              <OrthoTileSearch
                map={mapInstance}
                datasetId={dataset.id}
                initialQuery={initialTileQuery}
              />
            </div>
          </div>
        )}
      </div>

      <Drawer
        title="Dataset Details"
        placement="bottom"
        height="85vh"
        open={mobileInfoDrawerOpen}
        onClose={() => setMobileInfoDrawerOpen(false)}
        className="lg:hidden"
        styles={{
          body: { padding: "0", display: "flex", flexDirection: "column" },
        }}
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
        className="lg:hidden"
        styles={{ body: { padding: "16px", overflowY: "auto" } }}
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
            hasForestCover={hasDisplayableForestCover}
            hasDeadwood={hasDeadwood}
            hasAOI={hasAOI}
            forestCoverQuality={
              auditInfo?.forest_cover_quality as
                | "great"
                | "sentinel_ok"
                | "bad"
                | undefined
            }
            deadwoodQuality={
              auditInfo?.deadwood_quality as
                | "great"
                | "sentinel_ok"
                | "bad"
                | undefined
            }
            canBypassQualityRestriction={canAudit}
            canAudit={canAudit}
            deadwoodVariants={deadwoodVariants ?? []}
            forestVariants={forestVariants ?? []}
            selectedDeadwoodLabelId={effectiveSelectedDeadwoodLabelId}
            onDeadwoodVariantChange={setSelectedDeadwoodLabelId}
            selectedForestLabelId={effectiveSelectedForestLabelId}
            onForestVariantChange={setSelectedForestLabelId}
            opacity={layerControl.layerOpacity}
            setOpacity={setLayerOpacity}
            onReportClick={() => setReportModalOpen(true)}
            onEditLabels={() => openEditor()}
            onAuditClick={dataset ? () => navigate(`/dataset-audit/${dataset.id}`) : undefined}
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
