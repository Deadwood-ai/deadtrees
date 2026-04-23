import { useState } from "react";
import { Segmented, Slider, Checkbox, Button, Divider, Tooltip, Select } from "antd";
import {
  FlagOutlined,
  EditOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { mapColors } from "../../theme/mapColors";
import { standingDeadwoodLayerExplanation } from "../../utils/standingDeadwoodInfo";
import { ILabel } from "../../types/labels";

type QualityRating = "great" | "sentinel_ok" | "bad" | null | undefined;

interface DatasetLayerControlPanelProps {
  // Basemap
  mapStyle: string;
  onMapStyleChange: (style: string) => void;
  // Data layers
  showForestCover: boolean;
  setShowForestCover: (show: boolean) => void;
  showDeadwood: boolean;
  setShowDeadwood: (show: boolean) => void;
  showDroneImagery: boolean;
  setShowDroneImagery: (show: boolean) => void;
  showAOI?: boolean;
  setShowAOI?: (show: boolean) => void;
  // Layer availability
  hasForestCover: boolean;
  hasDeadwood: boolean;
  hasAOI?: boolean;
  // Quality ratings from audit
  forestCoverQuality?: QualityRating;
  deadwoodQuality?: QualityRating;
  canBypassQualityRestriction?: boolean;
  // Model variant selection (auditors only)
  canAudit?: boolean;
  deadwoodVariants?: ILabel[];
  forestVariants?: ILabel[];
  selectedDeadwoodLabelId?: number | null;
  onDeadwoodVariantChange?: (id: number) => void;
  selectedForestLabelId?: number | null;
  onForestVariantChange?: (id: number) => void;
  // Opacity (controls forest cover + deadwood layers)
  opacity: number;
  setOpacity: (value: number) => void;
  // Feedback actions
  onReportClick: () => void;
  onEditForestCover?: () => void;
  onEditDeadwood?: () => void;
  isLoggedIn: boolean;
}

// Quality indicator component
const QualityIcon = ({ quality }: { quality: QualityRating }) => {
  if (!quality) return null;

  const config = {
    great: { icon: <CheckCircleOutlined />, color: "text-green-500", tooltip: "Quality: Great" },
    sentinel_ok: { icon: <ExclamationCircleOutlined />, color: "text-yellow-500", tooltip: "Quality: OK for Sentinel" },
    bad: { icon: <WarningOutlined />, color: "text-red-500", tooltip: "Quality: Poor" },
  };

  const { icon, color, tooltip } = config[quality] || {};
  if (!icon) return null;

  return (
    <Tooltip title={tooltip} placement="left">
      <span className={`ml-1 ${color}`}>{icon}</span>
    </Tooltip>
  );
};

// Basemap options matching DeadtreesMap
const basemapOptions = [
  { value: "streets-v12", label: "Streets" },
  { value: "satellite-streets-v12", label: "Imagery" },
];

const DatasetLayerControlPanel = ({
  mapStyle,
  onMapStyleChange,
  showForestCover,
  setShowForestCover,
  showDeadwood,
  setShowDeadwood,
  showDroneImagery,
  setShowDroneImagery,
  showAOI,
  setShowAOI,
  hasForestCover,
  hasDeadwood,
  hasAOI,
  forestCoverQuality,
  deadwoodQuality,
  canBypassQualityRestriction = false,
  canAudit = false,
  deadwoodVariants,
  forestVariants,
  selectedDeadwoodLabelId,
  onDeadwoodVariantChange,
  selectedForestLabelId,
  onForestVariantChange,
  opacity,
  setOpacity,
  onReportClick,
  onEditForestCover,
  onEditDeadwood,
  isLoggedIn,
}: DatasetLayerControlPanelProps) => {
  const [showAttributions, setShowAttributions] = useState(false);
  const hasModelInfo = hasDeadwood || hasForestCover;

  return (
    <div
      className="flex w-full max-w-sm sm:w-56 flex-col rounded-2xl border border-gray-200/60 bg-white/95 p-4 shadow-xl backdrop-blur-sm pointer-events-auto overflow-hidden"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* Basemap Selection */}
      <div className="mb-2 text-xs font-medium text-gray-500">Basemap</div>
      <Segmented
        size="small"
        block
        value={mapStyle}
        onChange={(value) => onMapStyleChange(value as string)}
        options={basemapOptions}
      />

      <Divider className="my-3" />

      {/* Data Layers */}
      <div className="mb-2 text-xs font-medium text-gray-500">Data Layers</div>
      <div className="flex flex-col gap-1">
        {hasForestCover && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <Checkbox
                checked={showForestCover}
                onChange={(e) => setShowForestCover(e.target.checked)}
                disabled={forestCoverQuality === "bad" && !canBypassQualityRestriction}
              >
                <span className={`flex items-center gap-2 ${forestCoverQuality === "bad" && !canBypassQualityRestriction ? "opacity-50" : ""}`}>
                  <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: mapColors.forest.fill }} />
                  <span className="text-xs text-gray-600">Forest Cover</span>
                </span>
              </Checkbox>
              <QualityIcon quality={forestCoverQuality} />
            </div>
            {canAudit && forestVariants && forestVariants.length >= 1 && (
              <Select
                size="small"
                value={selectedForestLabelId ?? forestVariants[0]?.id}
                onChange={onForestVariantChange}
                className="w-full text-xs"
                popupMatchSelectWidth={false}
                options={forestVariants.map((l) => ({
                  value: l.id,
                  label: l.model_config?.module ?? `Label #${l.id}`,
                }))}
              />
            )}
          </div>
        )}
        {hasDeadwood && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <Checkbox
                checked={showDeadwood}
                onChange={(e) => setShowDeadwood(e.target.checked)}
                disabled={deadwoodQuality === "bad" && !canBypassQualityRestriction}
              >
                <span className={`flex items-center gap-2 ${deadwoodQuality === "bad" && !canBypassQualityRestriction ? "opacity-50" : ""}`}>
                  <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: mapColors.deadwood.fill }} />
                  <span className="text-xs text-gray-600">Standing Deadwood</span>
                </span>
              </Checkbox>
              <div className="flex items-center gap-1">
                <Tooltip title={<div className="max-w-xs text-xs leading-relaxed">{standingDeadwoodLayerExplanation}</div>} placement="left">
                  <InfoCircleOutlined className="cursor-help text-xs text-gray-400 hover:text-gray-600" />
                </Tooltip>
                <QualityIcon quality={deadwoodQuality} />
              </div>
            </div>
            {canAudit && deadwoodVariants && deadwoodVariants.length >= 1 && (
              <Select
                size="small"
                value={selectedDeadwoodLabelId ?? deadwoodVariants[0]?.id}
                onChange={onDeadwoodVariantChange}
                className="w-full text-xs"
                popupMatchSelectWidth={false}
                options={deadwoodVariants.map((l) => ({
                  value: l.id,
                  label: l.model_config?.module ?? `Label #${l.id}`,
                }))}
              />
            )}
          </div>
        )}
        <Checkbox
          checked={showDroneImagery}
          onChange={(e) => setShowDroneImagery(e.target.checked)}
        >
          <span className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm bg-gray-400" />
            <span className="text-xs text-gray-600">Drone Imagery</span>
          </span>
        </Checkbox>
        {hasAOI && setShowAOI && (
          <Checkbox
            checked={showAOI}
            onChange={(e) => setShowAOI(e.target.checked)}
          >
            <span className="flex items-center gap-2">
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  border: `2px solid ${mapColors.aoi.stroke}`,
                  display: "inline-block",
                }}
              />
              <span className="text-xs text-gray-600">Area of Interest</span>
            </span>
          </Checkbox>
        )}
      </div>

      <Divider className="my-3" />

      {/* Opacity - only affects forest cover and deadwood layers */}
      <div className="mb-1 text-xs font-medium text-gray-500">Layer Opacity</div>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={opacity}
        onChange={setOpacity}
        tooltip={{ formatter: (v) => `${Math.round((v || 0) * 100)}%` }}
        disabled={!showForestCover && !showDeadwood}
      />

      {hasModelInfo && (
        <>
          <Divider className="my-3" />
          <div className="mb-1 text-xs font-medium text-gray-500">Model Info</div>
          <div className="flex items-center gap-2">
            <Tooltip title="View model attributions and papers">
              <Button
                type="link"
                size="small"
                icon={<InfoCircleOutlined />}
                onClick={() => setShowAttributions((prev) => !prev)}
                className="m-0 p-0 text-xs"
              >
                {showAttributions ? "Hide Citations" : "View Citations"}
              </Button>
            </Tooltip>
          </div>
          {showAttributions && (
            <div className="mt-2 space-y-2 rounded bg-gray-50 p-2 text-xs">
              {hasDeadwood && (
                <div>
                  <div className="font-semibold text-gray-800">Deadwood Detection:</div>
                  <a
                    href="https://www.sciencedirect.com/science/article/pii/S2667393225000237"
                    className="text-blue-600 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Mohring et al., 2025 (ISPRS Open)
                  </a>
                </div>
              )}
              {hasForestCover && (
                <div>
                  <div className="font-semibold text-gray-800">Forest Cover:</div>
                  <a
                    href="https://proceedings.neurips.cc/paper_files/paper/2024/file/58efdd77196fa8159062afa0408245da-Paper-Datasets_and_Benchmarks_Track.pdf"
                    className="text-blue-600 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Veitch-Michaelis et al. (2024)
                  </a>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Feedback Section */}
      <div className="-mx-4 -mb-4 mt-3 bg-[#F8FAF9] px-4 pb-4 pt-3 border-t border-gray-100">
        <div className="mb-1 text-xs font-medium text-gray-500">Feedback</div>
        <p className="mb-3 text-xs text-gray-500">
          Help improve predictions by editing or reporting issues
        </p>
        <div className="flex flex-col gap-2">
          {/* Report button - always visible for logged-in users */}
          {isLoggedIn && (
            <Button
              size="small"
              icon={<FlagOutlined />}
              onClick={onReportClick}
              block
            >
              Report Issue
            </Button>
          )}

          {/* Contextual edit buttons - only show when corresponding layer is checked */}
          {isLoggedIn && showForestCover && hasForestCover && onEditForestCover && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={onEditForestCover}
              block
            >
              Edit Forest Cover
            </Button>
          )}

          {isLoggedIn && showDeadwood && hasDeadwood && onEditDeadwood && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={onEditDeadwood}
              block
            >
              Edit Deadwood
            </Button>
          )}

          {/* Prompt for non-logged-in users */}
          {!isLoggedIn && (
            <div className="text-center text-xs text-blue-600">
              <a href="/sign-in" className="text-blue-600 hover:underline">
                Sign in
              </a>
              {" "}to edit predictions
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DatasetLayerControlPanel;
