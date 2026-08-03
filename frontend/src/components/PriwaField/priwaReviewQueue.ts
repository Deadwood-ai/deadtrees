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

export const resolvePriwaReviewSelection = (
  items: IPriwaReviewItem[],
  selectedKey: string | null,
) =>
  items.find((item) => item.key === selectedKey) ??
  items.find(isOpenPriwaReviewItem) ??
  items[0] ??
  null;

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
