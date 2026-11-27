import type { Feature } from "ol";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import { never, noModifierKeys, shiftKeyOnly } from "ol/events/condition";
import type { Geometry, Polygon } from "ol/geom";
import Draw, { type Options as DrawOptions } from "ol/interaction/Draw";
import type { Pixel } from "ol/pixel";

/** OpenLayers' snap tolerance: a click this close to the first vertex closes the polygon. */
export const CLOSE_TOLERANCE_PX = 12;
/** A click this soon after the previous one counts as the second click of a double-click. */
export const DOUBLE_CLICK_MS = 500;

const isNearFirstVertex = (pixel: Pixel, firstVertexPixel: Pixel | null) =>
  !!firstVertexPixel &&
  Math.hypot(pixel[0] - firstVertexPixel[0], pixel[1] - firstVertexPixel[1]) <= CLOSE_TOLERANCE_PX;

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
  return isNearFirstVertex(clickPixel, firstVertexPixel);
}

/**
 * Whether releasing a freehand (Shift-drag) stroke finishes the polygon. OpenLayers finishes on
 * every release, so labelers who trace part of an outline freehand lost the polygon. A stroke
 * now finishes only when it ends on the first vertex; otherwise the outline stays open for more
 * strokes or clicks.
 */
export function shouldFinishFreehandStroke(releasePixel: Pixel, firstVertexPixel: Pixel | null): boolean {
  return isNearFirstVertex(releasePixel, firstVertexPixel);
}

/**
 * Polygon drawing for the label and AOI editors. A polygon finishes only on a click on its first
 * vertex, a double-click, or a freehand stroke that ends on the first vertex; a click near the
 * previous vertex or a freehand stroke released elsewhere keeps it open.
 *
 * Freehand (Shift-drag) strokes are handled here instead of by OpenLayers: OpenLayers finishes the
 * polygon on every release and discards it on a Shift-click, and continuing its sketch after a
 * stroke leaves stray vertices. Each stroke appends its points to the open outline.
 */
export class EditorPolygonDraw extends Draw {
  private sketch: Feature<Geometry> | null = null;
  private lastDownAt = Number.NEGATIVE_INFINITY;
  private previousDownAt = Number.NEGATIVE_INFINITY;
  /** Whether a Shift press is drawing a freehand stroke. */
  private inFreehandStroke = false;
  /** Where the current stroke began, until its first drag adds it to the outline. */
  private strokeStart: number[] | null = null;

  constructor(options: Omit<DrawOptions, "type" | "condition" | "finishCondition" | "freehandCondition">) {
    super({
      ...options,
      type: "Polygon",
      freehandCondition: never,
      condition: (event) => {
        this.previousDownAt = this.lastDownAt;
        this.lastDownAt = event.originalEvent.timeStamp;
        return noModifierKeys(event);
      },
      finishCondition: (event) => {
        if (shouldFinishPolygon(event.pixel, this.firstVertexPixel(), this.lastDownAt - this.previousDownAt)) {
          return true;
        }
        // Not a finish: place the vertex the click asked for, as any other click would.
        this.appendCoordinates([event.coordinate]);
        return false;
      },
    });
    this.on("drawstart", (event) => {
      this.sketch = event.feature;
    });
    this.on(["drawend", "drawabort"], () => {
      this.sketch = null;
    });
  }

  override handleEvent(event: MapBrowserEvent<PointerEvent>): boolean {
    if (event.type === "pointerdown" && shiftKeyOnly(event)) {
      this.inFreehandStroke = true;
      this.strokeStart = event.coordinate;
      return false;
    }
    if (!this.inFreehandStroke) return super.handleEvent(event);

    if (event.type === "pointerdrag") {
      // Starts the outline on the first stroke, then extends it. A Shift-click without a drag adds nothing.
      this.appendCoordinates(this.strokeStart ? [this.strokeStart, event.coordinate] : [event.coordinate]);
      this.strokeStart = null;
      return false;
    }
    if (event.type === "pointerup") {
      this.inFreehandStroke = false;
      this.strokeStart = null;
      if (this.hasEnoughVertices() && shouldFinishFreehandStroke(event.pixel, this.firstVertexPixel())) {
        this.finishDrawing();
      }
      return false;
    }
    return super.handleEvent(event);
  }

  private ring(): number[][] | undefined {
    return (this.sketch?.getGeometry() as Polygon | undefined)?.getCoordinates()[0];
  }

  /** The open outline holds three vertices or more; its ring also repeats the cursor point and the first vertex. */
  private hasEnoughVertices(): boolean {
    return (this.ring()?.length ?? 0) >= 5;
  }

  private firstVertexPixel(): Pixel | null {
    const ring = this.ring();
    const map = this.getMap();
    return ring?.length && map ? map.getPixelFromCoordinate(ring[0]) : null;
  }
}
