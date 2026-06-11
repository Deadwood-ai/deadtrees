import { Button, Slider } from "antd";
import { DownloadOutlined } from "@ant-design/icons";

import { mapColors } from "../../../theme/mapColors";
import MobileLayerRow from "./MobileLayerRow";
import MobileLayerTile from "./MobileLayerTile";
import MobileBottomSheet from "./MobileBottomSheet";
import { mobileMapThumbnails } from "./mobileMapThumbnails";

interface MobileLayerDrawerProps {
  open: boolean;
  mapStyle: string;
  showForest: boolean;
  showDeadwood: boolean;
  showPublicContributions: boolean;
  publicContributionsCount: number;
  opacity: number;
  onClose: () => void;
  onMapStyleChange: (style: string) => void;
  setShowForest: (show: boolean) => void;
  setShowDeadwood: (show: boolean) => void;
  setShowPublicContributions: (show: boolean) => void;
  setOpacity: (opacity: number) => void;
  onDownloadPublicTreeObservations: () => void;
}

const baseMapOptions = [
  {
    value: "wayback",
    label: "Satellite",
    image: mobileMapThumbnails.satellite,
  },
  {
    value: "streets-v12",
    label: "Street map",
    image: mobileMapThumbnails.streets,
  },
];

const SectionHeading = ({ children }: { children: string }) => (
  <div className="mb-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
    {children}
  </div>
);

const MobileLayerDrawer = ({
  open,
  mapStyle,
  showForest,
  showDeadwood,
  showPublicContributions,
  publicContributionsCount,
  opacity,
  onClose,
  onMapStyleChange,
  setShowForest,
  setShowDeadwood,
  setShowPublicContributions,
  setOpacity,
  onDownloadPublicTreeObservations,
}: MobileLayerDrawerProps) => {
  const modelLayersVisible = showForest || showDeadwood;

  return (
    <MobileBottomSheet open={open} onClose={onClose} title="Layers">
      <div className="space-y-5">
        <section>
          <SectionHeading>Map style</SectionHeading>
          <div className="grid grid-cols-2 gap-3">
            {baseMapOptions.map((option) => (
              <MobileLayerTile
                key={option.value}
                thumb={option.image}
                title={option.label}
                active={mapStyle === option.value}
                onClick={() => onMapStyleChange(option.value)}
              />
            ))}
          </div>
        </section>

        <section>
          <SectionHeading>Map layers</SectionHeading>
          <div className="space-y-2.5">
            <MobileLayerRow
              thumb={mobileMapThumbnails.treeCover}
              title="Tree cover"
              checked={showForest}
              swatchColor={mapColors.forest.fill}
              onChange={setShowForest}
            />
            <MobileLayerRow
              thumb={mobileMapThumbnails.deadwood}
              title="Deadwood"
              checked={showDeadwood}
              swatchColor={mapColors.deadwood.fill}
              onChange={setShowDeadwood}
            />
            <div className="rounded-[18px] border border-slate-200 bg-white px-3.5 pb-1 pt-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
              <div className="flex items-center justify-between">
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-semibold ${
                      modelLayersVisible ? "text-slate-950" : "text-slate-400"
                    }`}
                  >
                    Layer opacity
                  </span>
                  <span className="block text-xs text-slate-400">
                    Tree cover and deadwood
                  </span>
                </span>
                <span
                  className={`text-xs font-semibold ${
                    modelLayersVisible ? "text-slate-600" : "text-slate-400"
                  }`}
                >
                  {Math.round(opacity * 100)}%
                </span>
              </div>
              <Slider
                min={0}
                max={1}
                step={0.01}
                value={opacity}
                onChange={setOpacity}
                disabled={!modelLayersVisible}
                tooltip={{
                  formatter: (value) => `${Math.round((value || 0) * 100)}%`,
                }}
              />
            </div>
          </div>
        </section>

        <section>
          <SectionHeading>Feedback</SectionHeading>
          <div className="space-y-2.5">
            <MobileLayerRow
              thumb={mobileMapThumbnails.communityPoints}
              title="Point observations"
              checked={showPublicContributions}
              count={publicContributionsCount}
              onChange={setShowPublicContributions}
            />
            <Button
              block
              icon={<DownloadOutlined />}
              disabled={publicContributionsCount === 0}
              onClick={onDownloadPublicTreeObservations}
            >
              Download CSV
            </Button>
          </div>
        </section>
      </div>
    </MobileBottomSheet>
  );
};

export default MobileLayerDrawer;
