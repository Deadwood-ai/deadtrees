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
export const getPriwaReviewTargetPixel = (
  mapRect: IPriwaReviewRect,
  queueRect: IPriwaReviewRect | null,
  treePanelRect: IPriwaReviewRect | null,
): IPriwaReviewTargetPixel => {
  const visibleLeft = queueRect
    ? Math.max(mapRect.left, queueRect.right + PANEL_GAP_PX)
    : mapRect.left;
  const visibleRight = treePanelRect
    ? Math.min(mapRect.right, treePanelRect.left - PANEL_GAP_PX)
    : mapRect.right;
  const hasVisibleGap = visibleRight > visibleLeft;
  const targetX = hasVisibleGap
    ? (visibleLeft + visibleRight) / 2
    : (mapRect.left + mapRect.right) / 2;

  return {
    x: targetX - mapRect.left,
    y: (mapRect.top + mapRect.bottom) / 2 - mapRect.top,
  };
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
