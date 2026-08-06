import { App } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  resolvePriwaReviewItemToActivate,
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
  projectId: string;
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

const reviewSelectionStorageKey = (projectId: string) =>
  `deadtrees-priwa-field:review-selection:${projectId}`;

const readPersistedReviewSelection = (projectId: string) => {
  try {
    return window.sessionStorage.getItem(reviewSelectionStorageKey(projectId));
  } catch {
    return null;
  }
};

export function usePriwaReviewController({
  projectId,
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
  const { message } = App.useApp();
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(
    () => readPersistedReviewSelection(projectId),
  );
  const activatedReviewKeyRef = useRef<string | null>(null);
  const [groupEditorDraft, setGroupEditorDraft] =
    useState<IPriwaBefallsgruppeEditorDraft | null>(null);
  const flightReview = usePriwaFlightReview({
    points,
    mosaics,
    groups,
    isLoadingGroups,
    groupsErrorMessage,
    enableMosaics: true,
    autoEnableMatchedMosaics: !isMobile,
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

  const persistReviewSelection = useCallback(
    (key: string | null) => {
      setSelectedReviewKey(key);
      try {
        if (key) {
          window.sessionStorage.setItem(
            reviewSelectionStorageKey(projectId),
            key,
          );
        } else {
          window.sessionStorage.removeItem(
            reviewSelectionStorageKey(projectId),
          );
        }
      } catch {
        // Selection persistence is a convenience; private browsing may disable it.
      }
    },
    [projectId],
  );

  const activateReviewItem = useCallback(
    (item: IPriwaReviewItem) => {
      activatedReviewKeyRef.current = item.key;
      persistReviewSelection(item.key);
      showOnlyMosaics(reviewItemDatasetIds(item));
    },
    [persistReviewSelection, showOnlyMosaics],
  );

  const selectReviewItem = useCallback(
    (item: IPriwaReviewItem) => {
      activateReviewItem(item);
      if (item.kind === "unassigned-upload") {
        zoomToMosaicFootprint(item.mosaic);
      } else {
        zoomToTrees(item.treeIds);
      }
    },
    [activateReviewItem, zoomToMosaicFootprint, zoomToTrees],
  );

  useEffect(() => {
    if (isMobile || isWorkspaceLoading) return;

    const selectedItemToActivate = resolvePriwaReviewItemToActivate(
      reviewItems,
      selectedReviewKey,
      activatedReviewKeyRef.current,
    );
    if (selectedItemToActivate) {
      selectReviewItem(selectedItemToActivate);
      return;
    }
    if (reviewItems.some((item) => item.key === selectedReviewKey)) {
      return;
    }

    const nextItem = resolvePriwaReviewSelection(
      reviewItems,
      selectedReviewKey,
    );
    if (nextItem) selectReviewItem(nextItem);
    else {
      activatedReviewKeyRef.current = null;
      persistReviewSelection(null);
    }
  }, [
    isMobile,
    isWorkspaceLoading,
    reviewItems,
    persistReviewSelection,
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
      if (item) activateReviewItem(item);
    },
    [activateReviewItem, reviewItems],
  );

  const saveGroup = useCallback(
    async (input: IPriwaBefallsgruppeSaveInput) => {
      try {
        if (!isGroupStateReady) {
          throw new Error(
            "Befallsgruppen können erst nach erfolgreichem Laden bearbeitet werden.",
          );
        }
        const savedGroupId = await onSaveGroup(input);
        if (typeof savedGroupId === "string") {
          persistReviewSelection(`group:${savedGroupId}`);
        }
        message.success(
          input.datasetIds.length > 0
            ? "Befallsgruppe und Befliegung gespeichert"
            : "Befallsgruppe gespeichert · Befliegung noch offen",
        );
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
    [isGroupStateReady, message, onSaveGroup, persistReviewSelection],
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
    [isGroupStateReady, message, onDeleteGroup],
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
    [assignMosaicToGroup, isGroupStateReady, message, mosaics],
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
