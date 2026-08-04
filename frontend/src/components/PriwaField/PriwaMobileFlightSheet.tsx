import { AimOutlined, BorderOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Switch, Tag, Tooltip } from "antd";
import { useEffect, useRef } from "react";

import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaMosaic } from "./usePriwaMosaics";

interface PriwaMobileFlightSheetProps {
  mosaics: IPriwaMosaic[];
  areBoundariesVisible: boolean;
  isOpen: boolean;
  focusedMosaicId: string | null;
  onZoomToMosaic: (mosaic: IPriwaMosaic) => void;
  onBoundariesVisibilityChange: (visible: boolean) => void;
  onOpenChange: (open: boolean) => void;
}

export default function PriwaMobileFlightSheet({
  mosaics,
  areBoundariesVisible,
  isOpen,
  focusedMosaicId,
  onZoomToMosaic,
  onBoundariesVisibilityChange,
  onOpenChange,
}: PriwaMobileFlightSheetProps) {
  const focusedCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen || !focusedMosaicId) return;
    const frame = window.requestAnimationFrame(() => {
      focusedCardRef.current?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedMosaicId, isOpen]);

  return (
    <>
      <Tooltip title="Befliegungen" placement="right">
        <Button
          className="pointer-events-auto shadow-md md:hidden"
          shape="circle"
          size="large"
          icon={<BorderOutlined />}
          type={areBoundariesVisible ? "primary" : "default"}
          onClick={() => onOpenChange(true)}
          aria-label="Befliegungen öffnen"
          aria-pressed={areBoundariesVisible}
        />
      </Tooltip>

      <Drawer
        title={`Befliegungen (${mosaics.length})`}
        placement="bottom"
        height="72dvh"
        open={isOpen}
        onClose={() => onOpenChange(false)}
        rootClassName="priwa-layer-sheet-root"
        className="md:hidden"
        styles={{
          header: { padding: "12px 16px" },
          body: {
            padding: "0 0 calc(env(safe-area-inset-bottom, 0px) + 16px)",
            overflow: "hidden",
          },
        }}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-slate-200 bg-cyan-50 px-4 py-3 text-xs text-cyan-950">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">Befliegungsgrenzen anzeigen</span>
              <Switch
                size="small"
                checked={areBoundariesVisible}
                onChange={onBoundariesVisibilityChange}
                aria-label="Alle Befliegungsgrenzen anzeigen"
              />
            </div>
            <p className="mt-1">
              Auf Mobilgeräten werden nur die Grenzen bestätigt erfasster
              Umfeldbefliegungen angezeigt.
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {mosaics.length === 0 ? (
              <Empty
                className="py-12"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Keine Befliegungen verfügbar"
              />
            ) : (
              <div className="space-y-2">
                {mosaics.map((mosaic) => (
                  <div
                    key={mosaic.id}
                    ref={
                      mosaic.id === focusedMosaicId ? focusedCardRef : undefined
                    }
                    className={`rounded-lg border bg-white p-3 shadow-sm ${
                      mosaic.id === focusedMosaicId
                        ? "border-emerald-600 ring-2 ring-emerald-100"
                        : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div
                          className="truncate text-sm font-semibold text-slate-900"
                          title={mosaic.label}
                        >
                          {mosaic.label}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          Aufnahme {formatPriwaReviewDate(mosaic.captureDate)}
                        </div>
                      </div>
                      <Tag
                        className="m-0 shrink-0"
                        color={
                          mosaic.flightType === "umfeldbefliegung"
                            ? "green"
                            : "gold"
                        }
                      >
                        {mosaic.flightType === "umfeldbefliegung"
                          ? "Bestätigt"
                          : "Vorschlag"}
                      </Tag>
                    </div>

                    <div className="mt-3">
                      <Button
                        size="small"
                        icon={<AimOutlined />}
                        disabled={!mosaic.bbox}
                        onClick={() => {
                          onBoundariesVisibilityChange(true);
                          onZoomToMosaic(mosaic);
                          onOpenChange(false);
                        }}
                      >
                        Grenze zeigen
                      </Button>
                    </div>
                    {!mosaic.bbox && (
                      <div className="mt-2 text-xs text-amber-700">
                        Keine Kartengrenze verfügbar
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Drawer>
    </>
  );
}
