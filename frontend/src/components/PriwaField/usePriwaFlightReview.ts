import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  enableMosaics: boolean;
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
  enableMosaics,
  onSetFlightType,
  onAssignFlightToGroup,
}: UsePriwaFlightReviewOptions) {
  const [enabledMosaicIds, setEnabledMosaicIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedMosaicId, setSelectedMosaicId] = useState<string | null>(null);
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
    () =>
      enableMosaics
        ? reviewMosaics.filter((mosaic) => enabledMosaicIds.has(mosaic.id))
        : [],
    [enableMosaics, enabledMosaicIds, reviewMosaics],
  );
  const selectedMosaic = useMemo(
    () =>
      selectedMosaicId
        ? (reviewMosaics.find((mosaic) => mosaic.id === selectedMosaicId) ??
          null)
        : null,
    [reviewMosaics, selectedMosaicId],
  );
  useEffect(() => {
    if (
      selectedMosaicId &&
      !reviewMosaics.some((mosaic) => mosaic.id === selectedMosaicId)
    ) {
      setSelectedMosaicId(null);
    }
  }, [reviewMosaics, selectedMosaicId]);

  useEffect(() => {
    setEnabledMosaicIds((currentIds) =>
      reconcilePriwaMosaicVisibility(
        currentIds,
        reviewMosaics.map((mosaic) => mosaic.id),
      ),
    );
  }, [reviewMosaics]);

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

  const showOnlyMosaics = useCallback((mosaicIds: string[]) => {
    setEnabledMosaicIds(new Set(mosaicIds));
    setSelectedMosaicId(mosaicIds[0] ?? null);
  }, []);

  const selectMatchedMosaicForPoint = useCallback(
    (point: IPriwaPoint) => {
      const mosaicId = matches.mosaicIdByPointId[point.id];
      if (mosaicId) showOnlyMosaics([mosaicId]);
    },
    [matches.mosaicIdByPointId, showOnlyMosaics],
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

  return {
    ...matches,
    reviewMosaics,
    enabledMosaics,
    enabledMosaicIds,
    selectedMosaic,
    selectedMosaicId,
    setSelectedMosaicId,
    setMosaicVisibility,
    showOnlyMosaics,
    selectMatchedMosaicForPoint,
    setFlightType,
    assignMosaicToGroup,
  };
}
