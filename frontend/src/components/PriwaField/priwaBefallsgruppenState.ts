import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeEditorDraft,
} from "./types";

export const arePriwaBefallsgruppenReady = (
  isLoading: boolean,
  errorMessage: string | null,
) => !isLoading && errorMessage === null;

export const groupsForPriwaMosaicMatching = (
  groups: IPriwaBefallsgruppe[],
  isLoading: boolean,
  errorMessage: string | null,
) => (arePriwaBefallsgruppenReady(isLoading, errorMessage) ? groups : []);

export const resolveInitialFlightGroupDraft = (
  currentDraft: IPriwaBefallsgruppeEditorDraft | null,
  initialDatasetId: string | null,
  groupCount: number,
  isReady: boolean,
) => {
  if (currentDraft || !initialDatasetId || !isReady) return currentDraft;

  return {
    name: `Befallsgruppe ${groupCount + 1}`,
    origin: "manual" as const,
    treeIds: [],
    datasetIds: [initialDatasetId],
  };
};

export const indexPriwaBefallsgruppenByTreeId = (
  groups: IPriwaBefallsgruppe[],
) =>
  Object.fromEntries(
    groups.flatMap((group) =>
      group.treeIds.map((treeId) => [treeId, group] as const),
    ),
  ) as Record<string, IPriwaBefallsgruppe>;
