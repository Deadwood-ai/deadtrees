export const reconcilePriwaMosaicVisibility = (
  currentEnabledIds: ReadonlySet<string>,
  reviewMosaicIds: string[],
) =>
  new Set(
    reviewMosaicIds.filter((mosaicId) => currentEnabledIds.has(mosaicId)),
  );
