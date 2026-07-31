import type { IPriwaBefallsgruppe } from "./types";

export const arePriwaBefallsgruppenReady = (
  isLoading: boolean,
  errorMessage: string | null,
) => !isLoading && errorMessage === null;

export const groupsForPriwaMosaicMatching = (
  groups: IPriwaBefallsgruppe[],
  isLoading: boolean,
  errorMessage: string | null,
) => (arePriwaBefallsgruppenReady(isLoading, errorMessage) ? groups : []);

export const indexPriwaBefallsgruppenByTreeId = (
  groups: IPriwaBefallsgruppe[],
) =>
  Object.fromEntries(
    groups.flatMap((group) =>
      group.treeIds.map((treeId) => [treeId, group] as const),
    ),
  ) as Record<string, IPriwaBefallsgruppe>;
