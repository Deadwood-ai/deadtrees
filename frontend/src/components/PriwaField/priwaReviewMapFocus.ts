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
const FIELD_SIDE_PADDING_PX = 48;
/** With the flight list beside the map the bottom bar is hidden; keep the map tall. */
const FIELD_SIDE_PANEL_TOP_PADDING_PX = 56;
const FIELD_SIDE_PANEL_BOTTOM_PADDING_PX = 40;
const FIELD_MIN_VISIBLE_HEIGHT_PX = 160;

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
  const { left: visibleLeft, right: visibleRight } = getVisibleHorizontalBounds(
    mapRect,
    queueRect,
    treePanelRect,
  );
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
  const visible = getVisibleHorizontalBounds(mapRect, queueRect, detailRect);
  return [
    MAP_TOP_PADDING_PX,
    mapRect.right - visible.right,
    MAP_BOTTOM_PADDING_PX,
    visible.left - mapRect.left,
  ];
};

export const getPriwaLeftmostVisibleRect = (
  ...rects: Array<IPriwaReviewRect | null>
): IPriwaReviewRect | null =>
  rects.reduce<IPriwaReviewRect | null>((leftmost, rect) => {
    if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) {
      return leftmost;
    }
    return !leftmost || rect.left < leftmost.left ? rect : leftmost;
  }, null);

/**
 * Fit padding for the touch-first field layout. The bottom flight bar and the
 * primary actions need vertical room; an open side flight panel needs room on
 * the left.
 */
export const getPriwaFieldFitPadding = (
  mapRect: IPriwaReviewRect,
  flightPanelRect: IPriwaReviewRect | null,
  flightSheetRect: IPriwaReviewRect | null = null,
): [number, number, number, number] => {
  const hasSidePanel =
    !!flightPanelRect && flightPanelRect.right > flightPanelRect.left;
  const panelInset = hasSidePanel
    ? flightPanelRect.right - mapRect.left + PANEL_GAP_PX
    : 0;
  let top = hasSidePanel ? FIELD_SIDE_PANEL_TOP_PADDING_PX : MAP_TOP_PADDING_PX;
  let bottom = hasSidePanel
    ? FIELD_SIDE_PANEL_BOTTOM_PADDING_PX
    : MAP_BOTTOM_PADDING_PX;
  const mapHeight = mapRect.bottom - mapRect.top;
  if (mapHeight - top - bottom < FIELD_MIN_VISIBLE_HEIGHT_PX) {
    // Short landscape phones: keep at least a usable strip for the footprint.
    const spare = Math.max(0, mapHeight - FIELD_MIN_VISIBLE_HEIGHT_PX);
    top = Math.round(spare * 0.45);
    bottom = spare - top;
  }
  if (flightSheetRect) {
    bottom = Math.min(
      mapHeight - top - 24,
      Math.max(bottom, mapRect.bottom - flightSheetRect.top + PANEL_GAP_PX),
    );
  }
  return [
    top,
    FIELD_SIDE_PADDING_PX,
    bottom,
    Math.max(FIELD_SIDE_PADDING_PX, panelInset),
  ];
};

export const getPriwaMapFitPadding = (
  mapElement: HTMLElement,
  isMobile: boolean,
): [number, number, number, number] => {
  if (isMobile) {
    const flightPanelRect = document
      .querySelector<HTMLElement>("[data-priwa-flight-panel]")
      ?.getBoundingClientRect();
    return getPriwaFieldFitPadding(
      mapElement.getBoundingClientRect(),
      flightPanelRect ?? null,
      document
        .querySelector<HTMLElement>(
          '.map-mobile-bottom-sheet[aria-label="Befliegungen"]',
        )
        ?.getBoundingClientRect() ?? null,
    );
  }

  const queueRect = document
    .querySelector<HTMLElement>("[data-priwa-review-queue-panel]")
    ?.getBoundingClientRect();
  const detailRect = document
    .querySelector<HTMLElement>("[data-priwa-review-detail-panel]")
    ?.getBoundingClientRect();
  const treePanelRect = document
    .querySelector<HTMLElement>("[data-priwa-review-tree-panel]")
    ?.getBoundingClientRect();
  return getPriwaReviewFitPadding(
    mapElement.getBoundingClientRect(),
    queueRect ?? null,
    getPriwaLeftmostVisibleRect(detailRect ?? null, treePanelRect ?? null),
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
