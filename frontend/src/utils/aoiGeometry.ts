/** The AOI model stores an empty MultiPolygon when it finds no usable area. Readers see that as
 * no geometry (nothing to draw, edit or place patches in) plus `noUsableArea`, which says why. */
export function withoutEmptyGeometry<T extends { geometry?: unknown }>(aoi: T): T & { noUsableArea: boolean } {
  const coordinates = (aoi.geometry as { coordinates?: unknown[] } | null | undefined)?.coordinates;
  const noUsableArea = Array.isArray(coordinates) && coordinates.length === 0;
  return { ...aoi, geometry: noUsableArea ? null : aoi.geometry, noUsableArea };
}
