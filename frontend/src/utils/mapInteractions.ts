import { defaults as defaultInteractions } from "ol/interaction/defaults";

interface CreateMapInteractionsOptions {
  doubleClickZoom?: boolean;
  disableRotation?: boolean;
}

export function createMapInteractions({
  doubleClickZoom = false,
  disableRotation = false,
}: CreateMapInteractionsOptions = {}) {
  return defaultInteractions({
    doubleClickZoom,
    pinchRotate: !disableRotation,
    altShiftDragRotate: !disableRotation,
  });
}
