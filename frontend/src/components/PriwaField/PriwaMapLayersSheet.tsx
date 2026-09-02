import { Button, Switch, Tooltip } from "antd";
import { FullscreenOutlined, WarningOutlined } from "@ant-design/icons";

import MobileBottomSheet from "../MapControls/mobile/MobileBottomSheet";
import MobileLayerRow from "../MapControls/mobile/MobileLayerRow";
import MobileLayerTile from "../MapControls/mobile/MobileLayerTile";
import MobileMapSectionHeading from "../MapControls/mobile/MobileMapSectionHeading";
import { mobileMapThumbnails } from "../MapControls/mobile/mobileMapThumbnails";
import type { PriwaBaseLayer } from "./types";

interface PriwaMapLayersSheetProps {
  open: boolean;
  baseLayer: PriwaBaseLayer;
  warnkarteAvailable: boolean;
  warnkarteLoading: boolean;
  warnkarteVisible: boolean;
  legendVisible: boolean;
  onClose: () => void;
  onBaseLayerChange: (layer: PriwaBaseLayer) => void;
  onWarnkarteVisibilityChange: (visible: boolean) => void;
  onLegendVisibilityChange: (visible: boolean) => void;
  onZoomToWarnkarte: () => void;
}

const baseLayerOptions: Array<{
  value: PriwaBaseLayer;
  label: string;
  image: string;
}> = [
  {
    value: "aerial",
    label: "Luftbild",
    image: mobileMapThumbnails.satellite,
  },
  {
    value: "topographic",
    label: "Topografische Karte",
    image: mobileMapThumbnails.streets,
  },
];

export default function PriwaMapLayersSheet({
  open,
  baseLayer,
  warnkarteAvailable,
  warnkarteLoading,
  warnkarteVisible,
  legendVisible,
  onClose,
  onBaseLayerChange,
  onWarnkarteVisibilityChange,
  onLegendVisibilityChange,
  onZoomToWarnkarte,
}: PriwaMapLayersSheetProps) {
  const isWarnkarteActive = warnkarteAvailable && warnkarteVisible;

  return (
    <MobileBottomSheet
      open={open}
      title="Kartenebenen"
      closeLabel="Kartenebenen schließen"
      onClose={onClose}
      initialSnap="compact"
      compactRatio={0.38}
      expandedRatio={0.7}
      hideFrom="lg"
    >
      <div className="space-y-3">
        <section>
          <MobileMapSectionHeading>Basiskarte</MobileMapSectionHeading>
          <div className="grid grid-cols-2 gap-2.5">
            {baseLayerOptions.map((option) => (
              <MobileLayerTile
                key={option.value}
                thumb={option.image}
                title={option.label}
                active={baseLayer === option.value}
                onClick={() => onBaseLayerChange(option.value)}
              />
            ))}
          </div>
        </section>

        <section>
          <MobileMapSectionHeading>Zusätzliche Ebene</MobileMapSectionHeading>
          <MobileLayerRow
            icon={<WarningOutlined />}
            title="Warnkarte"
            description={
              warnkarteLoading
                ? "Warnkarte wird geladen"
                : warnkarteAvailable
                  ? "Gefahrenbereiche"
                  : "Beim Aktivieren laden"
            }
            checked={isWarnkarteActive}
            toggleLabel={
              isWarnkarteActive
                ? "Warnkarte ausblenden"
                : "Warnkarte einblenden"
            }
            onChange={onWarnkarteVisibilityChange}
            secondaryAction={
              isWarnkarteActive ? (
                <Tooltip title="Zur Warnkarte zoomen">
                  <Button
                    type="text"
                    shape="circle"
                    icon={<FullscreenOutlined />}
                    aria-label="Zur Warnkarte zoomen"
                    onClick={onZoomToWarnkarte}
                  />
                </Tooltip>
              ) : null
            }
          />
          <div className="mt-2 flex min-h-9 items-center justify-between rounded-xl bg-slate-50 px-3 py-1.5">
            <span className="text-xs font-medium text-slate-700">
              Legende anzeigen
            </span>
            <Switch
              size="small"
              checked={isWarnkarteActive && legendVisible}
              disabled={!isWarnkarteActive}
              aria-label="Warnkarten-Legende anzeigen"
              onChange={onLegendVisibilityChange}
            />
          </div>
        </section>
      </div>
    </MobileBottomSheet>
  );
}
