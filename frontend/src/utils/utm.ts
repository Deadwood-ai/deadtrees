/**
 * UTM (Universal Transverse Mercator) utility functions
 *
 * Handles UTM zone calculations and coordinate transformations.
 * Reference patches are stored in their local UTM zone for accurate ground measurements.
 */

import { transform } from "ol/proj";
import { register } from "ol/proj/proj4";
import proj4 from "proj4";

// Register proj4 with OpenLayers
register(proj4);

/**
 * Calculate UTM zone from WGS84 longitude
 * @param lon Longitude in degrees (WGS84)
 * @returns UTM zone number (1-60)
 */
export function getUtmZoneNumber(lon: number): number {
  return Math.floor((lon + 180) / 6) + 1;
}

/**
 * Determine if location is in northern or southern hemisphere
 * @param lat Latitude in degrees (WGS84)
 * @returns 'N' for northern, 'S' for southern hemisphere
 */
export function getUtmHemisphere(lat: number): "N" | "S" {
  return lat >= 0 ? "N" : "S";
}

/**
 * Calculate full UTM zone string from WGS84 coordinates
 * @param lon Longitude in degrees (WGS84)
 * @param lat Latitude in degrees (WGS84)
 * @returns UTM zone string (e.g., "32N", "33S")
 */
export function calculateUtmZone(lon: number, lat: number): string {
  const zone = getUtmZoneNumber(lon);
  const hemisphere = getUtmHemisphere(lat);
  return `${zone}${hemisphere}`;
}

/**
 * Get EPSG code for a UTM zone
 * @param utmZone UTM zone string (e.g., "32N", "33S")
 * @returns EPSG code (e.g., 32632 for 32N, 32733 for 33S)
 */
export function getUtmEpsgCode(utmZone: string): number {
  const match = utmZone.match(/^(\d+)([NS])$/);
  if (!match) {
    throw new Error(`Invalid UTM zone format: ${utmZone}`);
  }

  const zone = parseInt(match[1], 10);
  const hemisphere = match[2];

  if (zone < 1 || zone > 60) {
    throw new Error(`Invalid UTM zone number: ${zone}`);
  }

  // EPSG codes: 326xx for northern hemisphere, 327xx for southern
  return hemisphere === "N" ? 32600 + zone : 32700 + zone;
}

/**
 * Define proj4 projection for a UTM zone if not already defined
 * @param utmZone UTM zone string (e.g., "32N")
 */
export function defineUtmProjection(utmZone: string): void {
  const epsgCode = getUtmEpsgCode(utmZone);
  const epsgString = `EPSG:${epsgCode}`;

  // Check if already defined
  if (proj4.defs(epsgString)) {
    return;
  }

  const match = utmZone.match(/^(\d+)([NS])$/);
  if (!match) {
    throw new Error(`Invalid UTM zone format: ${utmZone}`);
  }

  const zone = parseInt(match[1], 10);
  const hemisphere = match[2];

  // Proj4 definition for UTM zone
  const proj4Def = `+proj=utm +zone=${zone} ${hemisphere === "S" ? "+south" : ""} +datum=WGS84 +units=m +no_defs`;

  proj4.defs(epsgString, proj4Def);
  register(proj4);
}

/**
 * Transform coordinates from Web Mercator to UTM
 * @param x X coordinate in EPSG:3857 (Web Mercator)
 * @param y Y coordinate in EPSG:3857 (Web Mercator)
 * @param utmZone Target UTM zone (e.g., "32N")
 * @returns [x, y] coordinates in UTM projection
 */
export function webMercatorToUtm(x: number, y: number, utmZone: string): [number, number] {
  defineUtmProjection(utmZone);
  const epsgCode = getUtmEpsgCode(utmZone);
  return transform([x, y], "EPSG:3857", `EPSG:${epsgCode}`) as [number, number];
}

/**
 * Transform coordinates from UTM to Web Mercator
 * @param x X coordinate in UTM
 * @param y Y coordinate in UTM
 * @param utmZone Source UTM zone (e.g., "32N")
 * @returns [x, y] coordinates in EPSG:3857 (Web Mercator)
 */
export function utmToWebMercator(x: number, y: number, utmZone: string): [number, number] {
  defineUtmProjection(utmZone);
  const epsgCode = getUtmEpsgCode(utmZone);
  return transform([x, y], `EPSG:${epsgCode}`, "EPSG:3857") as [number, number];
}

/**
 * Calculate UTM zone from Web Mercator coordinates
 * @param x X coordinate in EPSG:3857 (Web Mercator)
 * @param y Y coordinate in EPSG:3857 (Web Mercator)
 * @returns UTM zone string (e.g., "32N")
 */
export function getUtmZoneFromWebMercator(x: number, y: number): string {
  // Transform to WGS84 first
  const [lon, lat] = transform([x, y], "EPSG:3857", "EPSG:4326");
  return calculateUtmZone(lon, lat);
}

/**
 * Create a square polygon in UTM coordinates
 * @param centerX Center X in UTM
 * @param centerY Center Y in UTM
 * @param sizeMeters Side length in meters
 * @returns GeoJSON Polygon in UTM coordinates
 */
export function createUtmSquare(centerX: number, centerY: number, sizeMeters: number): GeoJSON.Polygon {
  const halfSize = sizeMeters / 2;

  return {
    type: "Polygon",
    coordinates: [
      [
        [centerX - halfSize, centerY - halfSize], // Bottom-left
        [centerX + halfSize, centerY - halfSize], // Bottom-right
        [centerX + halfSize, centerY + halfSize], // Top-right
        [centerX - halfSize, centerY + halfSize], // Top-left
        [centerX - halfSize, centerY - halfSize], // Closing point
      ],
    ],
  };
}

/**
 * Transform a GeoJSON Polygon from UTM to Web Mercator
 * @param polygon GeoJSON Polygon in UTM coordinates
 * @param utmZone UTM zone of the source polygon
 * @returns GeoJSON Polygon in EPSG:3857 (Web Mercator)
 */
export function transformPolygonUtmToWebMercator(polygon: GeoJSON.Polygon, utmZone: string): GeoJSON.Polygon {
  defineUtmProjection(utmZone);
  const epsgCode = getUtmEpsgCode(utmZone);

  const transformedCoords = polygon.coordinates.map((ring) =>
    ring.map(([x, y]) => {
      const [transformedX, transformedY] = transform([x, y], `EPSG:${epsgCode}`, "EPSG:3857");
      return [transformedX, transformedY];
    }),
  );

  return {
    type: "Polygon",
    coordinates: transformedCoords,
  };
}

/**
 * Transform a GeoJSON Polygon from Web Mercator to UTM
 * @param polygon GeoJSON Polygon in EPSG:3857 (Web Mercator)
 * @param utmZone Target UTM zone
 * @returns GeoJSON Polygon in UTM coordinates
 */
export function transformPolygonWebMercatorToUtm(polygon: GeoJSON.Polygon, utmZone: string): GeoJSON.Polygon {
  defineUtmProjection(utmZone);
  const epsgCode = getUtmEpsgCode(utmZone);

  const transformedCoords = polygon.coordinates.map((ring) =>
    ring.map(([x, y]) => {
      const [transformedX, transformedY] = transform([x, y], "EPSG:3857", `EPSG:${epsgCode}`);
      return [transformedX, transformedY];
    }),
  );

  return {
    type: "Polygon",
    coordinates: transformedCoords,
  };
}

/**
 * Get target ground size for a patch resolution
 * @param resolutionCm Resolution in cm (5, 10, or 20)
 * @returns Target side length in meters
 */
export function getTargetGroundSize(resolutionCm: 5 | 10 | 20): number {
  const sizes: Record<5 | 10 | 20, number> = {
    20: 204.8, // 20cm/px * 1024px = 204.8m
    10: 102.4, // 10cm/px * 1024px = 102.4m
    5: 51.2, // 5cm/px * 1024px = 51.2m
  };
  return sizes[resolutionCm];
}
