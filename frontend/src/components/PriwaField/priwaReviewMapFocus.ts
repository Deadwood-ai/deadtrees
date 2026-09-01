interface IPriwaReviewRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface IPriwaReviewTargetPixel {
  x: number;
  y: number;
}

const PANEL_GAP_PX = 16;
const MAP_TOP_PADDING_PX = 96;
const MAP_BOTTOM_PADDING_PX = 120;

const getVisibleHorizontalBounds = (
  mapRect: IPriwaReviewRect,
  queueRect: IPriwaReviewRect | null,
  detailRect: IPriwaReviewRect | null,
) => ({
  left: queueRect
    ? Math.max(mapRect.left, queueRect.right + PANEL_GAP_PX)
    : mapRect.left,
  right: detailRect
    ? Math.min(mapRect.right, detailRect.left - PANEL_GAP_PX)
    : mapRect.right,
});

export const getPriwaReviewTargetPixel = (
  mapRect: IPriwaReviewRect,
  queueRect: IPriwaReviewRect | null,
  treePanelRect: IPriwaReviewRect | null,
): IPriwaReviewTargetPixel => {
  const { left: visibleLeft, right: visibleRight } =
    getVisibleHorizontalBounds(mapRect, queueRect, treePanelRect);
  const hasVisibleGap = visibleRight > visibleLeft;
  const targetX = hasVisibleGap
    ? (visibleLeft + visibleRight) / 2
    : (mapRect.left + mapRect.right) / 2;

  return {
    x: targetX - mapRect.left,
    y: (mapRect.top + mapRect.bottom) / 2 - mapRect.top,
  };
};

export const getPriwaReviewFitPadding = (
  mapRect: IPriwaReviewRect,
  queueRect: IPriwaReviewRect | null,
  detailRect: IPriwaReviewRect | null,
): [number, number, number, number] => {
  const visible = getVisibleHorizontalBounds(
    mapRect,
    queueRect,
    detailRect,
  );
  return [
    MAP_TOP_PADDING_PX,
    mapRect.right - visible.right,
    MAP_BOTTOM_PADDING_PX,
    visible.left - mapRect.left,
  ];
};

export const getPriwaMapFitPadding = (
  mapElement: HTMLElement,
  isMobile: boolean,
): [number, number, number, number] => {
  if (isMobile) return [96, 48, 120, 48];

  const queueRect = document
    .querySelector<HTMLElement>("[data-priwa-review-queue-panel]")
    ?.getBoundingClientRect();
  const detailRect = document
    .querySelector<HTMLElement>("[data-priwa-review-detail-panel]")
    ?.getBoundingClientRect();
  return getPriwaReviewFitPadding(
    mapElement.getBoundingClientRect(),
    queueRect ?? null,
    detailRect ?? null,
  );
};

export const getPriwaReviewMapCenter = (
  coordinate: number[],
  mapSize: number[],
  targetPixel: IPriwaReviewTargetPixel,
  resolution: number,
): [number, number] => [
  coordinate[0] - (targetPixel.x - mapSize[0] / 2) * resolution,
  coordinate[1] + (targetPixel.y - mapSize[1] / 2) * resolution,
];
