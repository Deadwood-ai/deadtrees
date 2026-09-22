import { CloseOutlined, DisconnectOutlined } from "@ant-design/icons";
import { Button } from "antd";
import type { ReactNode } from "react";

import MobileBottomSheet from "../MapControls/mobile/MobileBottomSheet";
import MobileMapSectionHeading from "../MapControls/mobile/MobileMapSectionHeading";
import PriwaFlightDetails from "./PriwaFlightDetails";
import PriwaFlightList from "./PriwaFlightList";
import type { IPriwaFlightListItem } from "./priwaFieldFlights";
import type { PriwaFlightPanelPlacement } from "./priwaFieldLayout";

interface PriwaFlightPanelProps {
  open: boolean;
  placement: PriwaFlightPanelPlacement;
  items: IPriwaFlightListItem[];
  isLoading: boolean;
  isOnline: boolean;
  offlineSection?: ReactNode;
  onClose: () => void;
  onShow: (mosaicId: string) => void;
  onCompare: (mosaicId: string) => void;
  onHide: (mosaicId: string) => void;
  onFit: (mosaicId: string) => void;
}

const PANEL_TITLE = "Befliegungen";

/**
 * Field-layout flight chooser: a bottom sheet in portrait, a side panel in
 * landscape. Lists every PRIWA orthomosaic of the project independent of the
 * review groups and lets the forester show one flight (plus one comparison).
 */
export default function PriwaFlightPanel({
  open,
  placement,
  items,
  isLoading,
  isOnline,
  offlineSection,
  onClose,
  onShow,
  onCompare,
  onHide,
  onFit,
}: PriwaFlightPanelProps) {
  if (!open) return null;

  const primary = items.find((item) => item.isPrimary) ?? null;
  const compare =
    items.find((item) => item.isVisible && !item.isPrimary) ?? null;
  const content = (
    <div data-testid="priwa-flight-panel-content" className="space-y-4">
      {!isOnline && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <DisconnectOutlined className="mt-0.5 shrink-0" />
          <span>
            Ohne Netz lassen sich nur offline gespeicherte Befliegungen
            anzeigen.
          </span>
        </div>
      )}
      {primary && (
        <PriwaFlightDetails
          primary={primary}
          compare={compare}
          onFit={onFit}
          onHide={onHide}
        />
      )}
      <section>
        <MobileMapSectionHeading>
          Alle Befliegungen{items.length > 0 ? ` (${items.length})` : ""}
        </MobileMapSectionHeading>
        <p className="-mt-1 mb-2 text-xs text-slate-500">
          Antippen zeigt eine Befliegung in voller Auflösung. Über das
          Vergleichssymbol lässt sich eine zweite dazuschalten.
        </p>
        <PriwaFlightList
          items={items}
          hasPrimary={!!primary}
          isLoading={isLoading}
          onShow={onShow}
          onCompare={onCompare}
          onHide={onHide}
        />
      </section>
      {offlineSection}
    </div>
  );

  if (placement === "sheet") {
    return (
      <MobileBottomSheet
        open
        title={PANEL_TITLE}
        closeLabel="Befliegungen schließen"
        onClose={onClose}
        initialSnap="expanded"
        compactRatio={0.42}
        expandedRatio={0.86}
        hideFrom="never"
      >
        {content}
      </MobileBottomSheet>
    );
  }

  return (
    <aside
      data-priwa-flight-panel
      data-testid="priwa-flight-panel"
      aria-label={PANEL_TITLE}
      className="priwa-flight-side-panel pointer-events-auto absolute bottom-5 left-4 z-[60] flex w-[20.5rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur"
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <h2 className="m-0 text-base font-semibold text-slate-950">
          {PANEL_TITLE}
        </h2>
        <Button
          shape="circle"
          icon={<CloseOutlined />}
          aria-label="Befliegungen schließen"
          onClick={onClose}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        {content}
      </div>
    </aside>
  );
}
