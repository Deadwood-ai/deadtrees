import { PlusOutlined, TableOutlined } from "@ant-design/icons";
import { Button, Empty, Segmented, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";

import UploadButton from "../Upload/UploadButton";
import PriwaReviewGroupDetails from "./PriwaReviewGroupDetails";
import PriwaReviewTreeInspector from "./PriwaReviewTreeInspector";
import PriwaReviewUploadDetails from "./PriwaReviewUploadDetails";
import {
  formatPriwaReviewDate,
  getPriwaGroupDateRange,
  priwaReviewStatusPresentation,
} from "./priwaReviewPresentation";
import type { IPriwaBefallsgruppeSaveInput, IPriwaPoint } from "./types";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";
import {
  isOpenPriwaReviewItem,
  type IPriwaReviewItem,
} from "./priwaReviewWorkspace";
import {
  filterPriwaReviewItems,
  type PriwaReviewFilter,
} from "./priwaReviewQueue";

interface PriwaReviewWorkbenchProps {
  items: IPriwaReviewItem[];
  points: IPriwaPoint[];
  mosaics: IPriwaMosaic[];
  selectedKey: string | null;
  isLoading: boolean;
  isSavingGroup: boolean;
  isClassifyingFlight: boolean;
  enabledMosaicIds: Set<string>;
  selectedTreeId: string | null;
  onSelect: (item: IPriwaReviewItem) => void;
  onOpenData: () => void;
  onCreateGroup: () => void;
  onFocusTree: (point: IPriwaPoint) => void;
  onEditTree: (point: IPriwaPoint) => void;
  onCloseTree: () => void;
  onEditGroup: (draft: IPriwaBefallsgruppeSaveInput) => void;
  onSaveGroup: (draft: IPriwaBefallsgruppeSaveInput) => Promise<void>;
  onAssignFlight: (groupId: string, datasetId: string) => Promise<void>;
  onSetMosaicVisibility: (mosaicId: string, isVisible: boolean) => void;
  onSetFlightType: (
    datasetId: string,
    flightType: PriwaFlightType,
  ) => Promise<void>;
  onCreateGroupForFlight: (mosaic: IPriwaMosaic) => void;
}

function ReviewQueueItem({
  item,
  points,
  isSelected,
  onSelect,
}: {
  item: IPriwaReviewItem;
  points: IPriwaPoint[];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const presentation = priwaReviewStatusPresentation[item.status];
  const isUpload = item.kind === "unassigned-upload";
  return (
    <button
      type="button"
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
        isSelected
          ? "border-emerald-600 bg-emerald-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
      }`}
      aria-current={isSelected ? "true" : undefined}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-950">
            {isUpload ? item.mosaic.label : item.name}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {isUpload
              ? `Aufnahme ${formatPriwaReviewDate(item.mosaic.captureDate)}`
              : `${item.treeIds.length} Bäume · ${getPriwaGroupDateRange(item, points)}`}
          </div>
        </div>
        <Tag className="m-0 shrink-0" color={presentation.color}>
          {presentation.label}
        </Tag>
      </div>
    </button>
  );
}

export default function PriwaReviewWorkbench({
  items,
  points,
  mosaics,
  selectedKey,
  isLoading,
  selectedTreeId,
  onSelect,
  onOpenData,
  onCreateGroup,
  onCloseTree,
  ...detailProps
}: PriwaReviewWorkbenchProps) {
  const [filter, setFilter] = useState<PriwaReviewFilter>("open");
  const visibleItems = useMemo(
    () => filterPriwaReviewItems(items, filter),
    [filter, items],
  );
  const selectedItem =
    visibleItems.find((item) => item.key === selectedKey) ??
    visibleItems[0] ??
    null;
  const openCount = items.filter(isOpenPriwaReviewItem).length;
  const selectedTree =
    selectedItem?.kind !== "unassigned-upload" &&
    selectedTreeId &&
    selectedItem.treeIds.includes(selectedTreeId)
      ? (points.find((point) => point.id === selectedTreeId) ?? null)
      : null;

  const selectItem = (item: IPriwaReviewItem) => {
    if (
      selectedTreeId &&
      (item.kind === "unassigned-upload" ||
        !item.treeIds.includes(selectedTreeId))
    ) {
      onCloseTree();
    }
    onSelect(item);
  };

  useEffect(() => {
    if (selectedItem && selectedItem.key !== selectedKey) {
      onSelect(selectedItem);
    }
  }, [onSelect, selectedItem, selectedKey]);

  return (
    <div className="pointer-events-none absolute inset-0 z-[52] hidden md:block">
      <aside className="pointer-events-auto absolute bottom-5 left-4 top-24 flex w-[21rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur">
        <header className="border-b border-slate-200 px-3 py-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold text-slate-950">
                PRIWA prüfen
              </h1>
              <p className="mt-0.5 text-xs text-slate-500">
                {openCount} offene {openCount === 1 ? "Aufgabe" : "Aufgaben"}
              </p>
            </div>
            <Button
              size="small"
              icon={<TableOutlined />}
              aria-label="Punktliste öffnen"
              onClick={onOpenData}
            >
              Daten
            </Button>
          </div>
          <Segmented<PriwaReviewFilter>
            className="mt-3"
            block
            size="small"
            value={filter}
            onChange={(nextFilter) => {
              onCloseTree();
              setFilter(nextFilter);
            }}
            options={[
              { label: "Offen", value: "open" },
              { label: "Fertig", value: "complete" },
              { label: "Uploads", value: "uploads" },
            ]}
          />
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
          {visibleItems.map((item) => (
            <ReviewQueueItem
              key={item.key}
              item={item}
              points={points}
              isSelected={item.key === selectedItem?.key}
              onSelect={() => selectItem(item)}
            />
          ))}
          {!isLoading && visibleItems.length === 0 && (
            <Empty
              className="py-10"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                filter === "open" ? "Alles geprüft" : "Keine Einträge"
              }
            />
          )}
          {isLoading && (
            <div className="px-3 py-8 text-center text-sm text-slate-500">
              Arbeitsliste wird geladen…
            </div>
          )}
        </div>
        <footer className="grid grid-cols-2 gap-2 border-t border-slate-200 p-2.5">
          <Button icon={<PlusOutlined />} onClick={onCreateGroup}>
            Neue Gruppe
          </Button>
          <UploadButton label="Befliegung" size="middle" />
        </footer>
      </aside>

      {selectedTree && (
        <aside
          data-testid="priwa-tree-inspector-panel"
          className="pointer-events-auto absolute bottom-5 right-[24.5rem] top-24 hidden w-[22rem] overflow-y-auto rounded-xl border border-slate-200 bg-white/95 p-4 shadow-xl backdrop-blur min-[1200px]:block"
        >
          <PriwaReviewTreeInspector
            point={selectedTree}
            onClose={onCloseTree}
            onEdit={detailProps.onEditTree}
            onFocus={detailProps.onFocusTree}
          />
        </aside>
      )}

      <aside
        data-testid="priwa-review-detail-panel"
        className="pointer-events-auto absolute bottom-5 right-4 top-24 w-[23rem] overflow-y-auto rounded-xl border border-slate-200 bg-white/95 p-4 shadow-xl backdrop-blur"
      >
        {selectedTree && (
          <div className="min-[1200px]:hidden">
            <PriwaReviewTreeInspector
              point={selectedTree}
              onClose={onCloseTree}
              onEdit={detailProps.onEditTree}
              onFocus={detailProps.onFocusTree}
            />
          </div>
        )}
        <div className={selectedTree ? "hidden min-[1200px]:block" : ""}>
          {!selectedItem ? (
            <Empty
              className="pt-24"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Eintrag zum Prüfen auswählen"
            />
          ) : selectedItem.kind === "unassigned-upload" ? (
            <PriwaReviewUploadDetails item={selectedItem} {...detailProps} />
          ) : (
            <PriwaReviewGroupDetails
              key={selectedItem.key}
              item={selectedItem}
              points={points}
              mosaics={mosaics}
              selectedTreeId={selectedTreeId}
              {...detailProps}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
