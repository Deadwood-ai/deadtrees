import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";

import { arePriwaBefallsgruppenReady } from "./priwaBefallsgruppenState";
import {
  buildPriwaReviewWorkspace,
  reviewItemDatasetIds,
  type IPriwaReviewItem,
} from "./priwaReviewWorkspace";
import {
  findPriwaReviewItemByGroup,
  findPriwaReviewItemByMosaic,
  findPriwaReviewItemByPoint,
  resolvePriwaReviewSelection,
} from "./priwaReviewQueue";
import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeEditorDraft,
  IPriwaBefallsgruppeSaveInput,
  IPriwaPoint,
} from "./types";
import { usePriwaFlightReview } from "./usePriwaFlightReview";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";

interface UsePriwaReviewControllerOptions {
  points: IPriwaPoint[];
  mosaics: IPriwaMosaic[];
  groups: IPriwaBefallsgruppe[];
  isMobile: boolean;
  isLoadingPoints: boolean;
  isLoadingGroups: boolean;
  isCogLoading: boolean;
  groupsErrorMessage: string | null;
  onSaveGroup: (input: IPriwaBefallsgruppeSaveInput) => Promise<unknown>;
  onDeleteGroup: (groupId: string) => Promise<unknown>;
  onSetFlightType: (input: {
    datasetId: string;
    flightType: PriwaFlightType;
  }) => Promise<unknown>;
  onAssignFlightToGroup: (input: {
    groupId: string;
    datasetId: string;
  }) => Promise<unknown>;
  zoomToTrees: (treeIds: string[]) => void;
  zoomToMosaicFootprint: (mosaic: IPriwaMosaic) => void;
}

export function usePriwaReviewController({
  points,
  mosaics,
  groups,
  isMobile,
  isLoadingPoints,
  isLoadingGroups,
  isCogLoading,
  groupsErrorMessage,
  onSaveGroup,
  onDeleteGroup,
  onSetFlightType,
  onAssignFlightToGroup,
  zoomToTrees,
  zoomToMosaicFootprint,
}: UsePriwaReviewControllerOptions) {
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(
    null,
  );
  const [groupEditorDraft, setGroupEditorDraft] =
    useState<IPriwaBefallsgruppeEditorDraft | null>(null);
  const flightReview = usePriwaFlightReview({
    points,
    mosaics,
    groups,
    isLoadingGroups,
    groupsErrorMessage,
    enableMosaics: !isMobile,
    onSetFlightType,
    onAssignFlightToGroup,
  });
  const { assignMosaicToGroup, showOnlyMosaics } = flightReview;
  const isGroupStateReady = arePriwaBefallsgruppenReady(
    isLoadingGroups,
    groupsErrorMessage,
  );
  const reviewItems = useMemo(
    () =>
      isGroupStateReady
        ? buildPriwaReviewWorkspace(points, mosaics, groups)
        : [],
    [groups, isGroupStateReady, mosaics, points],
  );
  const selectedReviewItem =
    reviewItems.find((item) => item.key === selectedReviewKey) ?? null;
  const selectedTreeIds = useMemo(
    () =>
      new Set(
        selectedReviewItem?.kind === "unassigned-upload"
          ? []
          : (selectedReviewItem?.treeIds ?? []),
      ),
    [selectedReviewItem],
  );
  const selectedGroupId =
    selectedReviewItem?.kind === "saved-group"
      ? (selectedReviewItem.group?.id ?? null)
      : null;
  const isWorkspaceLoading = isLoadingPoints || isLoadingGroups || isCogLoading;

  const selectReviewItem = useCallback(
    (item: IPriwaReviewItem) => {
      setSelectedReviewKey(item.key);
      showOnlyMosaics(reviewItemDatasetIds(item));
      if (item.kind === "unassigned-upload") {
        zoomToMosaicFootprint(item.mosaic);
      } else {
        zoomToTrees(item.treeIds);
      }
    },
    [showOnlyMosaics, zoomToMosaicFootprint, zoomToTrees],
  );

  useEffect(() => {
    if (isMobile || isWorkspaceLoading) return;
    if (
      selectedReviewKey &&
      reviewItems.some((item) => item.key === selectedReviewKey)
    ) {
      return;
    }

    const nextItem = resolvePriwaReviewSelection(
      reviewItems,
      selectedReviewKey,
    );
    if (nextItem) selectReviewItem(nextItem);
    else setSelectedReviewKey(null);
  }, [
    isMobile,
    isWorkspaceLoading,
    reviewItems,
    selectReviewItem,
    selectedReviewKey,
  ]);

  const selectReviewItemFromMosaic = useCallback(
    (mosaicId: string) => {
      const item = findPriwaReviewItemByMosaic(reviewItems, mosaicId);
      if (item) selectReviewItem(item);
    },
    [reviewItems, selectReviewItem],
  );
  const selectReviewItemFromGroup = useCallback(
    (groupId: string) => {
      const item = findPriwaReviewItemByGroup(reviewItems, groupId);
      if (item) selectReviewItem(item);
    },
    [reviewItems, selectReviewItem],
  );
  const selectReviewItemFromPoint = useCallback(
    (point: IPriwaPoint) => {
      const item = findPriwaReviewItemByPoint(reviewItems, point.id);
      if (item) selectReviewItem(item);
    },
    [reviewItems, selectReviewItem],
  );

  const saveGroup = useCallback(
    async (input: IPriwaBefallsgruppeSaveInput) => {
      try {
        if (!isGroupStateReady) {
          throw new Error(
            "Befallsgruppen können erst nach erfolgreichem Laden bearbeitet werden.",
          );
        }
        await onSaveGroup(input);
        message.success("Befallsgruppe gespeichert");
        setGroupEditorDraft(null);
      } catch (error) {
        message.error(
          error instanceof Error
            ? error.message
            : "Befallsgruppe konnte nicht gespeichert werden.",
        );
        throw error;
      }
    },
    [isGroupStateReady, onSaveGroup],
  );

  const deleteGroup = useCallback(
    async (groupId: string) => {
      try {
        if (!isGroupStateReady) {
          throw new Error(
            "Befallsgruppen können erst nach erfolgreichem Laden bearbeitet werden.",
          );
        }
        await onDeleteGroup(groupId);
        message.success("Befallsgruppe gelöscht");
        setGroupEditorDraft(null);
      } catch (error) {
        message.error(
          error instanceof Error
            ? error.message
            : "Befallsgruppe konnte nicht gelöscht werden.",
        );
        throw error;
      }
    },
    [isGroupStateReady, onDeleteGroup],
  );

  const assignFlight = useCallback(
    async (groupId: string, datasetId: string) => {
      if (!isGroupStateReady) {
        message.error(
          "Befallsgruppen können erst nach erfolgreichem Laden bearbeitet werden.",
        );
        return;
      }
      const mosaic = mosaics.find((candidate) => candidate.id === datasetId);
      if (mosaic) await assignMosaicToGroup(mosaic, groupId);
    },
    [assignMosaicToGroup, isGroupStateReady, mosaics],
  );

  const createGroupForFlight = useCallback(
    (mosaic: IPriwaMosaic) => {
      setGroupEditorDraft({
        name: `Befallsgruppe ${groups.length + 1}`,
        origin: "manual",
        treeIds: [],
        datasetIds: [mosaic.id],
      });
    },
    [groups.length],
  );
  const createGroup = useCallback(() => {
    setGroupEditorDraft({
      name: `Befallsgruppe ${groups.length + 1}`,
      origin: "manual",
      treeIds: [],
      datasetIds: [],
    });
  }, [groups.length]);

  return {
    ...flightReview,
    reviewItems,
    selectedReviewKey,
    selectedTreeIds,
    selectedGroupId,
    isWorkspaceLoading,
    groupEditorDraft,
    setGroupEditorDraft,
    selectReviewItem,
    selectReviewItemFromMosaic,
    selectReviewItemFromGroup,
    selectReviewItemFromPoint,
    saveGroup,
    deleteGroup,
    assignFlight,
    createGroup,
    createGroupForFlight,
  };
}
