import { message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { groupsForPriwaMosaicMatching } from "./priwaBefallsgruppenState";
import { reconcilePriwaMosaicVisibility } from "./priwaFlightReviewState";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import { usePriwaMosaicMatches } from "./usePriwaMosaicMatches";
import type { IPriwaMosaic, PriwaFlightType } from "./usePriwaMosaics";

interface UsePriwaFlightReviewOptions {
  points: IPriwaPoint[];
  mosaics: IPriwaMosaic[];
  groups: IPriwaBefallsgruppe[];
  isLoadingGroups: boolean;
  groupsErrorMessage: string | null;
  onSetFlightType: (input: {
    datasetId: string;
    flightType: PriwaFlightType;
  }) => Promise<unknown>;
  onAssignFlightToGroup: (input: {
    groupId: string;
    datasetId: string;
  }) => Promise<unknown>;
}

export function usePriwaFlightReview({
  points,
  mosaics,
  groups,
  isLoadingGroups,
  groupsErrorMessage,
  onSetFlightType,
  onAssignFlightToGroup,
}: UsePriwaFlightReviewOptions) {
  const [enabledMosaicIds, setEnabledMosaicIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedMosaicId, setSelectedMosaicId] = useState<string | null>(null);
  const [hoveredMosaicId, setHoveredMosaicIdState] = useState<string | null>(
    null,
  );
  const [groupDraftDatasetId, setGroupDraftDatasetId] = useState<string | null>(
    null,
  );
  const [isLayerPanelOpen, setLayerPanelOpen] = useState(false);
  const [isGroupPanelOpen, setGroupPanelOpen] = useState(false);
  const knownMosaicIdsRef = useRef<Set<string>>(new Set());
  const hoveredMosaicIdRef = useRef<string | null>(null);
  const mosaicMatchGroups = useMemo(
    () =>
      groupsForPriwaMosaicMatching(groups, isLoadingGroups, groupsErrorMessage),
    [groups, groupsErrorMessage, isLoadingGroups],
  );
  const matches = usePriwaMosaicMatches(points, mosaics, mosaicMatchGroups);
  const reviewMosaics = useMemo(
    () => [
      ...matches.matchedMosaics.map(({ mosaic }) => mosaic),
      ...matches.unmatchedMosaics.map(({ mosaic }) => mosaic),
    ],
    [matches.matchedMosaics, matches.unmatchedMosaics],
  );
  const enabledMosaics = useMemo(
    () => reviewMosaics.filter((mosaic) => enabledMosaicIds.has(mosaic.id)),
    [enabledMosaicIds, reviewMosaics],
  );
  const selectedMosaic = useMemo(
    () =>
      selectedMosaicId
        ? (reviewMosaics.find((mosaic) => mosaic.id === selectedMosaicId) ??
          null)
        : null,
    [reviewMosaics, selectedMosaicId],
  );
  const hoveredMosaic = useMemo(
    () =>
      hoveredMosaicId
        ? (reviewMosaics.find((mosaic) => mosaic.id === hoveredMosaicId) ??
          null)
        : null,
    [hoveredMosaicId, reviewMosaics],
  );
  const inspectedMosaic = hoveredMosaic ?? selectedMosaic;

  const setHoveredMosaicId = useCallback((mosaicId: string | null) => {
    hoveredMosaicIdRef.current = mosaicId;
    setHoveredMosaicIdState(mosaicId);
  }, []);

  useEffect(() => {
    if (
      selectedMosaicId &&
      !reviewMosaics.some((mosaic) => mosaic.id === selectedMosaicId)
    ) {
      setSelectedMosaicId(null);
    }
  }, [reviewMosaics, selectedMosaicId]);

  useEffect(() => {
    if (
      hoveredMosaicId &&
      !reviewMosaics.some((mosaic) => mosaic.id === hoveredMosaicId)
    ) {
      setHoveredMosaicId(null);
    }
  }, [hoveredMosaicId, reviewMosaics, setHoveredMosaicId]);

  useEffect(() => {
    const nextKnownIds = new Set(reviewMosaics.map((mosaic) => mosaic.id));
    const matchedIds = new Set(
      matches.matchedMosaics.map(({ mosaic }) => mosaic.id),
    );
    const previousKnownIds = knownMosaicIdsRef.current;

    setEnabledMosaicIds((currentIds) =>
      reconcilePriwaMosaicVisibility(
        currentIds,
        previousKnownIds,
        reviewMosaics.map((mosaic) => mosaic.id),
        matchedIds,
      ),
    );

    knownMosaicIdsRef.current = nextKnownIds;
  }, [matches.matchedMosaics, reviewMosaics]);

  const setMosaicVisibility = useCallback(
    (mosaicId: string, checked: boolean) => {
      setEnabledMosaicIds((currentIds) => {
        const nextIds = new Set(currentIds);
        if (checked) nextIds.add(mosaicId);
        else nextIds.delete(mosaicId);
        return nextIds;
      });
    },
    [],
  );

  const selectMatchedMosaicForPoint = useCallback(
    (point: IPriwaPoint) => {
      const mosaicId = matches.mosaicIdByPointId[point.id];
      if (mosaicId) setSelectedMosaicId(mosaicId);
    },
    [matches.mosaicIdByPointId],
  );

  const setFlightType = useCallback(
    async (datasetId: string, flightType: PriwaFlightType) => {
      try {
        await onSetFlightType({ datasetId, flightType });
        message.success(
          flightType === "umfeldbefliegung"
            ? "Als Umfeldbefliegung markiert"
            : flightType === "not_priwa"
              ? "Aus PRIWA ausgeschlossen"
              : "Prüfstatus zurückgesetzt",
        );
      } catch (error) {
        message.error(
          error instanceof Error
            ? error.message
            : "Befliegung konnte nicht klassifiziert werden.",
        );
      }
    },
    [onSetFlightType],
  );

  const assignMosaicToGroup = useCallback(
    async (mosaic: IPriwaMosaic, groupId: string) => {
      const group = groups.find((candidate) => candidate.id === groupId);
      if (!group) return;

      try {
        await onAssignFlightToGroup({
          groupId: group.id,
          datasetId: mosaic.id,
        });
        message.success(`${mosaic.label} wurde ${group.name} zugeordnet`);
      } catch (error) {
        message.error(
          error instanceof Error
            ? error.message
            : "Befliegung konnte nicht zugeordnet werden.",
        );
      }
    },
    [groups, onAssignFlightToGroup],
  );

  const openGroupDraftForMosaic = useCallback((mosaicId: string) => {
    setGroupDraftDatasetId(mosaicId);
    setLayerPanelOpen(false);
    setGroupPanelOpen(true);
  }, []);

  return {
    ...matches,
    reviewMosaics,
    enabledMosaics,
    enabledMosaicIds,
    selectedMosaicId,
    hoveredMosaicId,
    hoveredMosaicIdRef,
    inspectedMosaic,
    inspectedMosaicIsHovered: hoveredMosaic !== null,
    isInspectedMosaicVisible:
      inspectedMosaic !== null && enabledMosaicIds.has(inspectedMosaic.id),
    isLayerPanelOpen,
    isGroupPanelOpen,
    groupDraftDatasetId,
    setGroupDraftDatasetId,
    setLayerPanelOpen,
    setGroupPanelOpen,
    setSelectedMosaicId,
    setHoveredMosaicId,
    setMosaicVisibility,
    selectMatchedMosaicForPoint,
    setFlightType,
    assignMosaicToGroup,
    openGroupDraftForMosaic,
  };
}
