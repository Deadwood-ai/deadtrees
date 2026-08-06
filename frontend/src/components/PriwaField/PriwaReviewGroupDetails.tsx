import {
  AimOutlined,
  CheckCircleFilled,
  EditOutlined,
} from "@ant-design/icons";
import { Button, Tag } from "antd";
import { useState } from "react";

import type { IPriwaBefallsgruppeSaveInput, IPriwaPoint } from "./types";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";
import {
  resolvePriwaSuggestedAssignments,
  setPriwaDatasetAssignment,
  type IPriwaGroupReviewItem,
} from "./priwaReviewWorkspace";
import {
  formatPriwaReviewDate,
  getPriwaGroupDateRange,
  priwaReviewStatusPresentation,
} from "./priwaReviewPresentation";
import PriwaReviewFlightCard from "./PriwaReviewFlightCard";

interface PriwaReviewGroupDetailsProps {
  item: IPriwaGroupReviewItem;
  points: IPriwaPoint[];
  mosaics: IPriwaMosaic[];
  isSavingGroup: boolean;
  isClassifyingFlight: boolean;
  enabledMosaicIds: Set<string>;
  selectedTreeId: string | null;
  onSelectTree: (point: IPriwaPoint) => void;
  onFocusTree: (point: IPriwaPoint) => void;
  onEditTree: (point: IPriwaPoint) => void;
  onEditGroup: (draft: IPriwaBefallsgruppeSaveInput) => void;
  onSaveGroup: (draft: IPriwaBefallsgruppeSaveInput) => Promise<void>;
  onAssignFlight: (groupId: string, datasetId: string) => Promise<void>;
  onSetMosaicVisibility: (mosaicId: string, isVisible: boolean) => void;
  onSetFlightType: (
    datasetId: string,
    flightType: PriwaFlightType,
  ) => Promise<void>;
}

export default function PriwaReviewGroupDetails({
  item,
  points,
  mosaics,
  isSavingGroup,
  isClassifyingFlight,
  enabledMosaicIds,
  selectedTreeId,
  onSelectTree,
  onFocusTree,
  onEditTree,
  onEditGroup,
  onSaveGroup,
  onAssignFlight,
  onSetMosaicVisibility,
  onSetFlightType,
}: PriwaReviewGroupDetailsProps) {
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const mosaicsById = new Map(mosaics.map((mosaic) => [mosaic.id, mosaic]));
  const assignedMosaics = item.assignedDatasetIds.flatMap((id) => {
    const mosaic = mosaicsById.get(id);
    return mosaic ? [mosaic] : [];
  });
  const suggestedMosaics = item.suggestedDatasetIds.flatMap((id) => {
    const mosaic = mosaicsById.get(id);
    return mosaic ? [mosaic] : [];
  });
  const [suggestedAssignmentOverrideIds, setSuggestedAssignmentOverrideIds] =
    useState<string[] | null>(null);
  const eligibleSuggestedAssignmentIds = resolvePriwaSuggestedAssignments(
    suggestedAssignmentOverrideIds,
    item.draft.datasetIds,
    item.suggestedDatasetIds,
  );

  const setAssignment = (mosaic: IPriwaMosaic, isAssigned: boolean) => {
    if (item.kind === "suggested-group") {
      setSuggestedAssignmentOverrideIds((currentOverrideIds) =>
        setPriwaDatasetAssignment(
          resolvePriwaSuggestedAssignments(
            currentOverrideIds,
            item.draft.datasetIds,
            item.suggestedDatasetIds,
          ),
          mosaic.id,
          isAssigned,
        ),
      );
      return;
    }

    if (isAssigned && item.group) {
      void onAssignFlight(item.group.id, mosaic.id);
      return;
    }

    void onSaveGroup({
      ...item.draft,
      datasetIds: setPriwaDatasetAssignment(
        item.assignedDatasetIds,
        mosaic.id,
        false,
      ),
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <Tag color={priwaReviewStatusPresentation[item.status].color}>
          {priwaReviewStatusPresentation[item.status].label}
        </Tag>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">
          {item.name}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {item.treeIds.length} Bäume · {getPriwaGroupDateRange(item, points)}
        </p>
        {item.suggestionReason && (
          <p className="mt-2 rounded-md bg-sky-50 px-2.5 py-2 text-xs text-sky-900">
            {item.suggestionReason}
          </p>
        )}
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Käferbäume
          </h3>
          {item.confidenceLabel && (
            <span className="text-xs text-slate-500">
              Sicherheit {item.confidenceLabel}
            </span>
          )}
        </div>
        <div className="max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
          {item.treeIds.map((treeId) => {
            const point = pointsById.get(treeId);
            if (!point) return null;
            return (
              <div
                key={treeId}
                className={`flex items-center gap-2 px-2.5 py-2 transition ${
                  selectedTreeId === treeId
                    ? "bg-emerald-50 ring-1 ring-inset ring-emerald-300"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onSelectTree(point)}
                >
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {point.baumnr ? `Baum ${point.baumnr}` : "Ohne Baumnr"}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {point.baumart} · {formatPriwaReviewDate(point.datum)}
                  </span>
                </button>
                <Button
                  size="small"
                  type="text"
                  icon={<AimOutlined />}
                  aria-label="Baum auf Karte zeigen"
                  onClick={() => onFocusTree(point)}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  aria-label="Baum bearbeiten"
                  onClick={() => onEditTree(point)}
                />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Umfeldbefliegung
        </h3>
        <p className="-mt-1 mb-2 text-xs text-slate-500">
          Auge: auf Karte anzeigen · Auswahl: der Gruppe zuordnen
        </p>
        <div className="space-y-2">
          {assignedMosaics.map((mosaic) => (
            <PriwaReviewFlightCard
              key={mosaic.id}
              mosaic={mosaic}
              tone="assigned"
              isVisible={enabledMosaicIds.has(mosaic.id)}
              isAssigned
              isSaving={isSavingGroup}
              assignmentLabel="Dieser Gruppe zugeordnet"
              assignmentAriaLabel={`Zuordnung von ${mosaic.label} zur Gruppe aufheben`}
              onVisibilityChange={(isVisible) =>
                onSetMosaicVisibility(mosaic.id, isVisible)
              }
              onAssignmentChange={(isAssigned) =>
                setAssignment(mosaic, isAssigned)
              }
            >
              {mosaic.flightType === "umfeldbefliegung" ? (
                <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                  <CheckCircleFilled /> Als Umfeldbefliegung bestätigt
                </div>
              ) : (
                <Button
                  className="mt-2"
                  size="small"
                  type="primary"
                  loading={isClassifyingFlight}
                  onClick={() =>
                    void onSetFlightType(mosaic.id, "umfeldbefliegung")
                  }
                >
                  Befliegung bestätigen
                </Button>
              )}
            </PriwaReviewFlightCard>
          ))}

          {suggestedMosaics.map((mosaic) => (
            <PriwaReviewFlightCard
              key={mosaic.id}
              mosaic={mosaic}
              tone="suggested"
              isVisible={enabledMosaicIds.has(mosaic.id)}
              isAssigned={
                item.kind === "suggested-group" &&
                eligibleSuggestedAssignmentIds.includes(mosaic.id)
              }
              isSaving={isSavingGroup}
              assignmentLabel={
                item.kind === "suggested-group"
                  ? "Beim Übernehmen zuordnen"
                  : "Dieser Gruppe zuordnen"
              }
              assignmentAriaLabel={
                item.kind === "suggested-group"
                  ? `${mosaic.label} beim Übernehmen zuordnen`
                  : `${mosaic.label} dieser Gruppe zuordnen`
              }
              onVisibilityChange={(isVisible) =>
                onSetMosaicVisibility(mosaic.id, isVisible)
              }
              onAssignmentChange={(isAssigned) =>
                setAssignment(mosaic, isAssigned)
              }
            >
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="small"
                  danger
                  loading={isClassifyingFlight}
                  onClick={() => void onSetFlightType(mosaic.id, "not_priwa")}
                >
                  Nicht PRIWA-relevant
                </Button>
              </div>
            </PriwaReviewFlightCard>
          ))}

          {assignedMosaics.length === 0 && suggestedMosaics.length === 0 && (
            <div className="rounded-md border border-dashed border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              Für diese Gruppe wurde noch keine passende Befliegung gefunden.
            </div>
          )}
        </div>
      </section>

      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        {item.kind === "suggested-group" && (
          <Button
            type="primary"
            icon={<CheckCircleFilled />}
            loading={isSavingGroup}
            onClick={() =>
              void onSaveGroup({
                ...item.draft,
                datasetIds: eligibleSuggestedAssignmentIds,
              })
            }
          >
            Vorschlag übernehmen
          </Button>
        )}
        <Button
          icon={<EditOutlined />}
          disabled={isSavingGroup}
          onClick={() =>
            onEditGroup({
              ...item.draft,
              datasetIds:
                item.kind === "suggested-group"
                  ? eligibleSuggestedAssignmentIds
                  : item.draft.datasetIds,
            })
          }
        >
          Zusammensetzung bearbeiten
        </Button>
      </div>
    </div>
  );
}
