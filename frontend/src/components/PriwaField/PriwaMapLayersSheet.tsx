import { Button, Tooltip } from "antd";
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
  onClose: () => void;
  onBaseLayerChange: (layer: PriwaBaseLayer) => void;
  onWarnkarteVisibilityChange: (visible: boolean) => void;
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
  onClose,
  onBaseLayerChange,
  onWarnkarteVisibilityChange,
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
      compactRatio={0.28}
      expandedRatio={0.7}
      hideFrom="lg"
    >
      <div className="space-y-4">
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
        </section>
      </div>
    </MobileBottomSheet>
  );
}
