export const reconcilePriwaMosaicVisibility = (
  currentEnabledIds: ReadonlySet<string>,
  previousKnownIds: ReadonlySet<string>,
  reviewMosaicIds: string[],
  matchedMosaicIds: ReadonlySet<string>,
) =>
  new Set(
    reviewMosaicIds.filter(
      (mosaicId) =>
        currentEnabledIds.has(mosaicId) ||
        (!previousKnownIds.has(mosaicId) && matchedMosaicIds.has(mosaicId)),
    ),
  );
