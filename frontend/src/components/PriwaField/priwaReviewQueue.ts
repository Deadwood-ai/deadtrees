import {
  isOpenPriwaReviewItem,
  reviewItemDatasetIds,
  type IPriwaReviewItem,
} from "./priwaReviewWorkspace";

export type PriwaReviewFilter = "open" | "complete" | "uploads";

export const filterPriwaReviewItems = (
  items: IPriwaReviewItem[],
  filter: PriwaReviewFilter,
) =>
  items.filter((item) =>
    filter === "open"
      ? isOpenPriwaReviewItem(item)
      : filter === "complete"
        ? !isOpenPriwaReviewItem(item)
        : item.kind === "unassigned-upload",
  );

export const filterForPriwaReviewItem = (
  item: IPriwaReviewItem,
): PriwaReviewFilter => {
  if (item.kind === "unassigned-upload") return "uploads";
  return isOpenPriwaReviewItem(item) ? "open" : "complete";
};

export const resolvePriwaFilteredReviewSelection = (
  items: IPriwaReviewItem[],
  filter: PriwaReviewFilter,
  selectedKey: string | null,
  preferExternalSelection: boolean,
) => {
  const visibleItems = filterPriwaReviewItems(items, filter);
  return (
    visibleItems.find((item) => item.key === selectedKey) ??
    (preferExternalSelection
      ? items.find((item) => item.key === selectedKey)
      : null) ??
    visibleItems[0] ??
    null
  );
};

export const resolvePriwaReviewSelection = (
  items: IPriwaReviewItem[],
  selectedKey: string | null,
) =>
  items.find((item) => item.key === selectedKey) ??
  items.find(isOpenPriwaReviewItem) ??
  items[0] ??
  null;

export const resolvePriwaReviewItemToActivate = (
  items: IPriwaReviewItem[],
  selectedKey: string | null,
  activatedKey: string | null,
) =>
  selectedKey === activatedKey
    ? null
    : (items.find((item) => item.key === selectedKey) ?? null);

export const findPriwaReviewItemByMosaic = (
  items: IPriwaReviewItem[],
  mosaicId: string,
) =>
  items.find((item) => reviewItemDatasetIds(item).includes(mosaicId)) ?? null;

export const findPriwaReviewItemByGroup = (
  items: IPriwaReviewItem[],
  groupId: string,
) =>
  items.find(
    (item) => item.kind === "saved-group" && item.group?.id === groupId,
  ) ?? null;

export const findPriwaReviewItemByPoint = (
  items: IPriwaReviewItem[],
  pointId: string,
) =>
  items.find(
    (item) =>
      item.kind !== "unassigned-upload" && item.treeIds.includes(pointId),
  ) ?? null;

export const shouldClosePriwaReviewTree = (
  item: IPriwaReviewItem,
  selectedTreeId: string | null,
) =>
  !!selectedTreeId &&
  (item.kind === "unassigned-upload" || !item.treeIds.includes(selectedTreeId));
