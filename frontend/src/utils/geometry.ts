// polygon-clipping types are loose; call with spread args to satisfy overloads
import * as pc from "polygon-clipping";
import Geometry from "ol/geom/Geometry";
import Polygon from "ol/geom/Polygon";
import MultiPolygon from "ol/geom/MultiPolygon";

type PCRing = [number, number][]; // [[x,y], ...]
type PCPolygon = PCRing[]; // [outer, hole1, ...]
type PCMultiPolygon = PCPolygon[]; // array of polygons

function polygonToPC(poly: Polygon): PCMultiPolygon {
  const coords = poly.getCoordinates(); // rings
  return [coords.map((ring) => ring.map((c) => [c[0], c[1]]))];
}

function multiPolygonToPC(mpoly: MultiPolygon): PCMultiPolygon {
  const polys = mpoly.getCoordinates();
  return polys.map((poly) => poly.map((ring) => ring.map((c) => [c[0], c[1]])));
}

function olToPC(geom: Geometry): PCMultiPolygon | null {
  if (geom instanceof Polygon) return polygonToPC(geom);
  if (geom instanceof MultiPolygon) return multiPolygonToPC(geom);
  return null;
}

function pcToOL(mp: PCMultiPolygon): Polygon | MultiPolygon {
  if (mp.length === 1) {
    const rings = mp[0].map((ring) => ring.map(([x, y]) => [x, y] as [number, number]));
    return new Polygon(rings);
  }
  const polys = mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x, y] as [number, number])));
  return new MultiPolygon(polys);
}

export function union(a: Geometry, b: Geometry): Geometry | null {
  const A = olToPC(a);
  const B = olToPC(b);
  if (!A || !B) return null;
  // polygon-clipping can be exported under default in some bundlers; resolve safely
  const any = pc as unknown as {
    union?: (...polys: PCPolygon[]) => PCMultiPolygon;
    default?: { union?: (...polys: PCPolygon[]) => PCMultiPolygon };
  };
  const fn = any.union || any.default?.union;
  if (!fn) return null;
  const res = fn(...A, ...B);
  if (!res || res.length === 0) return null;
  return pcToOL(res);
}

export function difference(subject: Geometry, clip: Geometry): Geometry | null {
  console.debug("[geometry.difference] Input subject:", subject.getType());
  console.debug("[geometry.difference] Input clip:", clip.getType());

  const S = olToPC(subject);
  const C = olToPC(clip);

  console.debug("[geometry.difference] Converted to PC format:", {
    subjectPolygons: S?.length || 0,
    clipPolygons: C?.length || 0,
  });

  if (!S || !C) {
    console.error("[geometry.difference] Failed to convert geometries to PC format");
    return null;
  }

  const any = pc as unknown as {
    difference?: (...polys: PCPolygon[]) => PCMultiPolygon;
    default?: { difference?: (...polys: PCPolygon[]) => PCMultiPolygon };
  };
  const fn = any.difference || any.default?.difference;

  if (!fn) {
    console.error("[geometry.difference] polygon-clipping difference function not found");
    return null;
  }

  console.debug(
    "[geometry.difference] Calling polygon-clipping.difference with:",
    S.length,
    "subject polygons and",
    C.length,
    "clip polygons",
  );

  // For MultiPolygon subjects, we need to subtract clip from each polygon separately
  // then combine the results
  let res: PCMultiPolygon;
  if (S.length === 1) {
    // Single polygon subject - straightforward
    res = fn(S[0], ...C);
  } else {
    // MultiPolygon subject - apply difference to each polygon separately
    const results: PCMultiPolygon = [];
    for (const subjectPoly of S) {
      const polyResult = fn(subjectPoly, ...C);
      if (polyResult && polyResult.length > 0) {
        results.push(...polyResult);
      }
    }
    res = results;
  }

  console.debug("[geometry.difference] Result from polygon-clipping:", res, "length:", res?.length || 0);

  if (!res || res.length === 0) {
    console.warn("[geometry.difference] Result is empty - polygon would be completely removed");
    return null;
  }

  const olGeometry = pcToOL(res);
  console.debug("[geometry.difference] Converted back to OL geometry:", olGeometry?.getType());

  return olGeometry;
}

// Returns true if geometries have any overlapping area
export function intersects(a: Geometry, b: Geometry): boolean {
  const A = olToPC(a);
  const B = olToPC(b);
  if (!A || !B) return false;
  const any = pc as unknown as {
    intersection?: (...polys: PCPolygon[]) => PCMultiPolygon;
    default?: { intersection?: (...polys: PCPolygon[]) => PCMultiPolygon };
  };
  const fn = any.intersection || any.default?.intersection;
  if (!fn) return false;
  const inter = fn(...A, ...B);
  return Array.isArray(inter) && inter.length > 0;
}

// Returns intersection geometry (Polygon or MultiPolygon) in OL projection units, or null if no overlap
export function intersectionGeometry(a: Geometry, b: Geometry): Geometry | null {
  const A = olToPC(a);
  const B = olToPC(b);
  if (!A || !B) return null;
  const any = pc as unknown as {
    intersection?: (...polys: PCPolygon[]) => PCMultiPolygon;
    default?: { intersection?: (...polys: PCPolygon[]) => PCMultiPolygon };
  };
  const fn = any.intersection || any.default?.intersection;
  if (!fn) return null;
  const inter = fn(...A, ...B);
  if (!inter || inter.length === 0) return null;
  return pcToOL(inter);
}
