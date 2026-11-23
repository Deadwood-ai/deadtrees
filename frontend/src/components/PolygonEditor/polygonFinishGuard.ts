import type { Feature } from "ol";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import { noModifierKeys } from "ol/events/condition";
import type { Geometry, Polygon } from "ol/geom";
import type Draw from "ol/interaction/Draw";
import type { DrawEvent } from "ol/interaction/Draw";
import type { Pixel } from "ol/pixel";

/** OpenLayers' snap tolerance: a click this close to the first vertex closes the polygon. */
export const CLOSE_TOLERANCE_PX = 12;
/** A click this soon after the previous one counts as the second click of a double-click. */
export const DOUBLE_CLICK_MS = 500;

/**
 * Whether a click that OpenLayers would treat as finishing the polygon really finishes it.
 *
 * OpenLayers finishes a polygon on a click near its first vertex or near the last placed
 * vertex. The second rule exists for double-click, but labelers outlining small crowns place
 * vertices a few pixels apart, so ordinary clicks closed their shape. Only a click on the first
 * vertex or a double-click finishes here.
 */
export function shouldFinishPolygon(
  clickPixel: Pixel,
  firstVertexPixel: Pixel | null,
  msSincePreviousClick: number,
): boolean {
  if (msSincePreviousClick >= 0 && msSincePreviousClick < DOUBLE_CLICK_MS) return true;
  if (!firstVertexPixel) return false;
  const dx = clickPixel[0] - firstVertexPixel[0];
  const dy = clickPixel[1] - firstVertexPixel[1];
  return Math.hypot(dx, dy) <= CLOSE_TOLERANCE_PX;
}

/**
 * Draw options and wiring that stop a manual polygon from closing on a click near the previous
 * vertex. Pass `options` to `new Draw`, then call `attach` with the interaction. Freehand
 * drawing (Shift) is unchanged.
 */
export function createPolygonFinishGuard() {
  let draw: Draw | null = null;
  let sketch: Feature<Geometry> | null = null;
  let lastDownAt = Number.NEGATIVE_INFINITY;
  let previousDownAt = Number.NEGATIVE_INFINITY;

  const condition = (event: MapBrowserEvent) => {
    previousDownAt = lastDownAt;
    lastDownAt = event.originalEvent.timeStamp;
    return noModifierKeys(event);
  };

  const finishCondition = (event: MapBrowserEvent) => {
    const ring = (sketch?.getGeometry() as Polygon | undefined)?.getCoordinates()[0];
    const firstVertexPixel = ring?.length ? event.map.getPixelFromCoordinate(ring[0]) : null;
    if (shouldFinishPolygon(event.pixel, firstVertexPixel, lastDownAt - previousDownAt)) return true;
    // Not a finish: place the vertex the click asked for, as any other click would.
    draw?.appendCoordinates([event.coordinate]);
    return false;
  };

  const attach = (interaction: Draw) => {
    draw = interaction;
    interaction.on("drawstart", (event: DrawEvent) => {
      sketch = event.feature;
    });
    interaction.on(["drawend", "drawabort"], () => {
      sketch = null;
    });
  };

  return { options: { condition, finishCondition }, attach };
}
