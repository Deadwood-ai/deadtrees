import { Button, Tooltip } from "antd";
import {
  AreaChartOutlined,
  EnvironmentOutlined,
  LoadingOutlined,
} from "@ant-design/icons";

export type MobileMapPanel = "layers" | "analysis" | "time";

interface MobileMapControlsProps {
  activePanel: MobileMapPanel | null;
  hidden?: boolean;
  isAnalysisActive: boolean;
  isLocating: boolean;
  isTracking: boolean;
  hasLocationFix: boolean;
  onLocate: () => void;
  onOpenPanel: (panel: MobileMapPanel) => void;
}

const controlButtonClass =
  "pointer-events-auto !flex !h-12 !w-12 !min-w-12 !items-center !justify-center border-white/80 bg-white/95 shadow-lg shadow-slate-900/15 backdrop-blur-md";

const MapLayersIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M12 3.75 3.75 8.1 12 12.45l8.25-4.35L12 3.75Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <path
      d="m5.75 11.15-2 1.05L12 16.55l8.25-4.35-2-1.05"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="m5.75 15.2-2 1.05L12 20.6l8.25-4.35-2-1.05"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MobileMapControls = ({
  activePanel,
  hidden = false,
  isAnalysisActive,
  isLocating,
  isTracking,
  hasLocationFix,
  onLocate,
  onOpenPanel,
}: MobileMapControlsProps) => {
  if (hidden) return null;

  const locationIsActive = isTracking && hasLocationFix;

  return (
    <div
      className="pointer-events-none absolute right-3 top-[calc(5rem+env(safe-area-inset-top))] z-[54] flex flex-col gap-2 md:hidden"
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <Tooltip title="Use current location" placement="left">
        <Button
          shape="circle"
          type={locationIsActive ? "primary" : "default"}
          className={controlButtonClass}
          aria-label="Use current location"
          onClick={onLocate}
          icon={
            isLocating ? (
              <LoadingOutlined spin />
            ) : locationIsActive ? (
              <img
                src="/assets/location-heading.svg"
                alt=""
                className="h-7 w-7"
                aria-hidden="true"
              />
            ) : (
              <EnvironmentOutlined />
            )
          }
        />
      </Tooltip>

      <Tooltip title="Layers" placement="left">
        <Button
          shape="circle"
          type={activePanel === "layers" ? "primary" : "default"}
          className={`${controlButtonClass} ${
            activePanel === "layers" ? "!text-white" : "text-slate-700"
          }`}
          icon={<MapLayersIcon />}
          aria-label="Open map layers"
          aria-pressed={activePanel === "layers"}
          onClick={() => onOpenPanel("layers")}
        />
      </Tooltip>

      <Tooltip title="Analyze area" placement="left">
        <Button
          shape="circle"
          type={
            activePanel === "analysis" || isAnalysisActive
              ? "primary"
              : "default"
          }
          className={controlButtonClass}
          icon={<AreaChartOutlined />}
          aria-label="Open analysis controls"
          aria-pressed={activePanel === "analysis" || isAnalysisActive}
          onClick={() => onOpenPanel("analysis")}
        />
      </Tooltip>
    </div>
  );
};

export default MobileMapControls;
