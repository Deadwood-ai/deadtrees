import {
  AimOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  CloudDownloadOutlined,
  LoadingOutlined,
  PictureOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { Button, Tooltip } from "antd";

import { formatPriwaReviewDate } from "./priwaReviewPresentation";
import type { IPriwaMosaic } from "./usePriwaMosaics";

interface PriwaFlightBarProps {
  primary: IPriwaMosaic | null;
  isVisible: boolean;
  isAvailable: boolean;
  onToggleVisibility: () => void;
  flightCount: number;
  isLoading: boolean;
  isOpen: boolean;
  hasOfflineCopy: boolean;
  onOpen: () => void;
  onFit: () => void;
}

/**
 * Collapsed flight affordance for the field layout. One tap opens the flight list,
 * the second button re-frames the map on the displayed orthomosaic.
 */
export default function PriwaFlightBar({
  primary,
  isVisible,
  isAvailable,
  onToggleVisibility,
  flightCount,
  isLoading,
  isOpen,
  hasOfflineCopy,
  onOpen,
  onFit,
}: PriwaFlightBarProps) {
  const subline = primary
    ? [
        `Aufnahme ${formatPriwaReviewDate(primary.captureDate)}`,
        isVisible ? "Sichtbar" : "Ausgeblendet",
        hasOfflineCopy ? "offline gespeichert" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : isLoading
      ? "Befliegungen werden geladen"
      : flightCount === 0
        ? "Keine Befliegung im Projekt"
        : `${flightCount} verfügbar`;

  return (
    <div
      data-testid="priwa-flight-bar"
      className="pointer-events-auto flex max-w-[min(26rem,calc(100vw-7rem))] items-stretch overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-lg shadow-slate-950/15 backdrop-blur"
    >
      <button
        type="button"
        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent px-3 py-1.5 text-left"
        aria-label={
          primary
            ? `Befliegung ${primary.label}: Befliegungsliste öffnen`
            : "Befliegung wählen"
        }
        aria-expanded={isOpen}
        onClick={onOpen}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-base text-emerald-700">
          {isLoading && !primary ? (
            <LoadingOutlined spin />
          ) : hasOfflineCopy ? (
            <CloudDownloadOutlined />
          ) : (
            <PictureOutlined />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-950">
            {primary ? primary.label : "Befliegung wählen"}
          </span>
          <span className="block truncate text-xs text-slate-500">
            {subline}
          </span>
        </span>
        <UpOutlined
          className={`shrink-0 text-xs text-slate-400 transition ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {primary && (
        <Tooltip title="Auf Befliegung zoomen" placement="top">
          <button
            type="button"
            className="flex w-12 shrink-0 items-center justify-center border-0 border-l border-slate-200 bg-transparent text-base text-slate-700 active:bg-slate-100"
            aria-label="Auf Befliegung zoomen"
            onClick={onFit}
          >
            <AimOutlined />
          </button>
        </Tooltip>
      )}
      {primary && (
        <Tooltip title={isVisible ? "Ausblenden" : "Einblenden"}>
          <button
            type="button"
            className="flex w-12 shrink-0 items-center justify-center border-0 border-l border-slate-200 bg-transparent text-base text-slate-700 disabled:opacity-40"
            aria-label={`Ausgewählte Befliegung ${isVisible ? "ausblenden" : "einblenden"}`}
            aria-pressed={isVisible}
            disabled={!isVisible && !isAvailable}
            onClick={onToggleVisibility}
          >
            {isVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          </button>
        </Tooltip>
      )}
      {!primary && !isLoading && flightCount > 0 && (
        <Button
          type="primary"
          className="!m-1.5 !h-auto !rounded-xl"
          onClick={onOpen}
        >
          Öffnen
        </Button>
      )}
    </div>
  );
}
