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
