import type Geometry from "ol/geom/Geometry";
import MultiPolygon from "ol/geom/MultiPolygon";
import Polygon from "ol/geom/Polygon";

import { difference, union } from "../../../utils/geometry";

export function polygonParts(geometry: Geometry): Polygon[] {
	if (geometry instanceof Polygon) {
		return [geometry];
	}

	if (geometry instanceof MultiPolygon) {
		return geometry.getPolygons();
	}

	return [];
}

export function mergeAOIGeometries(first: Geometry, second: Geometry): Polygon[] | null {
	const merged = union(first, second);
	return merged ? polygonParts(merged) : null;
}

export function clipAOIGeometries(first: Geometry, second: Geometry): Polygon[] | null {
	const firstArea = first instanceof Polygon || first instanceof MultiPolygon ? first.getArea() : 0;
	const secondArea = second instanceof Polygon || second instanceof MultiPolygon ? second.getArea() : 0;
	const clipped = firstArea >= secondArea
		? difference(first, second)
		: difference(second, first);

	return clipped ? polygonParts(clipped) : null;
}

export function cutAOIGeometry(target: Geometry, cutter: Geometry): Polygon[] | null {
	const cut = difference(target, cutter);
	return cut ? polygonParts(cut) : null;
}
