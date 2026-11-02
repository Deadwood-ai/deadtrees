import Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import MultiPolygon from "ol/geom/MultiPolygon";
import Polygon from "ol/geom/Polygon";
import { difference, intersectionGeometry, intersects, union } from "./geometry";

/**
 * Area edits for the label editor: the user marks an area and it is merged into, or cut out
 * of, the polygons of the layer being edited. Results are returned as replacements so the
 * caller applies them as one undo step.
 */
export interface AreaEdit {
  removed: Feature<Geometry>[];
  added: Feature<Geometry>[];
}

/** Merges the area with every polygon it touches into one polygon. */
export function addArea(features: Feature<Geometry>[], area: Geometry): AreaEdit {
  const touched = features.filter((f) => overlaps(f, area));
  let merged: Geometry | null = area.clone();
  for (const f of touched) {
    merged = merged && union(merged, f.getGeometry()!);
  }
  if (!merged) return { removed: [], added: [] };
  return { removed: touched, added: splitParts(merged) };
}

/** Cuts the area out of every polygon it overlaps; polygons fully inside it disappear. */
export function removeArea(features: Feature<Geometry>[], area: Geometry): AreaEdit {
  const touched = features.filter((f) => overlaps(f, area));
  const added = touched.flatMap((f) => {
    const rest = difference(f.getGeometry()!, area);
    return rest ? splitParts(rest) : [];
  });
  return { removed: touched, added };
}

/** Keeps only the parts of each feature that lie inside the area. */
export function clipToArea(features: Feature<Geometry>[], area: Geometry): Feature<Geometry>[] {
  return features.flatMap((f) => {
    const inside = intersectionGeometry(f.getGeometry()!, area);
    return inside ? splitParts(inside) : [];
  });
}

function overlaps(feature: Feature<Geometry>, area: Geometry): boolean {
  const geometry = feature.getGeometry();
  return !!geometry && geometry.intersectsExtent(area.getExtent()) && intersects(geometry, area);
}

/** One feature per polygon part, marked as new so the save diff picks it up. */
function splitParts(geometry: Geometry): Feature<Geometry>[] {
  const parts =
    geometry instanceof MultiPolygon ? geometry.getPolygons() : geometry instanceof Polygon ? [geometry] : [];
  return parts.map((part) => {
    const feature = new Feature<Geometry>(part);
    feature.set("is_new", true);
    return feature;
  });
}
