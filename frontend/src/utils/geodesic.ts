/**
 * Geodesic utility functions for handling Web Mercator ↔ true ground distance conversions.
 *
 * Web Mercator (EPSG:3857) uses "pseudo-meters" that are only accurate at the equator.
 * At higher latitudes, the scale distorts. For example:
 * - At 45° latitude: 1 Web Mercator unit ≈ 0.707 ground meters
 * - At 60° latitude: 1 Web Mercator unit ≈ 0.5 ground meters
 *
 * These functions ensure we create geometries with correct ground dimensions.
 */

import { transform } from "ol/proj";
import { getDistance } from "ol/sphere";

/**
 * Calculate the Web Mercator distance needed to achieve a target ground distance at a given latitude.
 *
 * @param centerLat - Latitude in degrees (WGS84)
 * @param targetGroundMeters - Desired ground distance in meters
 * @returns Web Mercator distance (EPSG:3857 units) needed to achieve targetGroundMeters
 *
 * @example
 * // At 50° latitude, to get 204.8m ground distance:
 * const webMercDist = calculateWebMercatorDistance(50, 204.8);
 * // Returns ~318m in Web Mercator units (because of latitude distortion)
 */
export function calculateWebMercatorDistance(centerLat: number, targetGroundMeters: number): number {
  // Web Mercator scale factor at latitude: 1 / cos(lat)
  // This is the distortion factor - how much Web Mercator "stretches" at this latitude
  const latRad = (centerLat * Math.PI) / 180;
  const scaleFactor = 1 / Math.cos(latRad);

  // To get the target ground distance, we need to create a larger box in Web Mercator
  return targetGroundMeters * scaleFactor;
}

/**
 * Calculate the actual ground distance (geodesic) for a Web Mercator distance at a given latitude.
 *
 * @param centerLat - Latitude in degrees (WGS84)
 * @param webMercatorMeters - Distance in Web Mercator units (EPSG:3857)
 * @returns Actual ground distance in meters
 *
 * @example
 * // At 50° latitude, a 318m Web Mercator distance equals:
 * const groundDist = calculateGroundDistance(50, 318);
 * // Returns ~204.8m (true ground distance)
 */
export function calculateGroundDistance(centerLat: number, webMercatorMeters: number): number {
  const latRad = (centerLat * Math.PI) / 180;
  const scaleFactor = 1 / Math.cos(latRad);

  return webMercatorMeters / scaleFactor;
}

/**
 * Extract latitude from Web Mercator coordinates.
 *
 * @param x - X coordinate in EPSG:3857 (Web Mercator)
 * @param y - Y coordinate in EPSG:3857 (Web Mercator)
 * @returns Latitude in degrees (WGS84)
 */
export function getLatitudeFromWebMercator(x: number, y: number): number {
  const [, lat] = transform([x, y], "EPSG:3857", "EPSG:4326");
  return lat;
}

/**
 * Create a geodesically-correct square polygon in Web Mercator projection.
 *
 * @param centerX - Center X coordinate in EPSG:3857
 * @param centerY - Center Y coordinate in EPSG:3857
 * @param targetGroundSizeMeters - Desired side length in true ground meters
 * @returns GeoJSON Polygon with correct ground dimensions
 *
 * @example
 * const patch = createGeodesicSquare(
 *   1234567, // center X in Web Mercator
 *   5678901, // center Y in Web Mercator
 *   204.8    // 204.8m ground distance (20cm resolution)
 * );
 */
export function createGeodesicSquare(
  centerX: number,
  centerY: number,
  targetGroundSizeMeters: number,
): GeoJSON.Polygon {
  // Get latitude at this location to calculate distortion
  const centerLat = getLatitudeFromWebMercator(centerX, centerY);

  // Calculate the Web Mercator size needed to achieve target ground size
  const webMercSize = calculateWebMercatorDistance(centerLat, targetGroundSizeMeters);

  const halfSize = webMercSize / 2;

  return {
    type: "Polygon",
    coordinates: [
      [
        [centerX - halfSize, centerY - halfSize], // Bottom-left corner
        [centerX + halfSize, centerY - halfSize], // Bottom-right corner
        [centerX + halfSize, centerY + halfSize], // Top-right corner
        [centerX - halfSize, centerY + halfSize], // Top-left corner
        [centerX - halfSize, centerY - halfSize], // Closing point (must match first point per GeoJSON spec)
      ],
    ],
  };
}

/**
 * Verify the ground dimensions of a polygon in Web Mercator.
 * Useful for debugging and validation.
 *
 * @param polygon - GeoJSON Polygon in EPSG:3857
 * @returns Object with width and height in true ground meters
 */
export function verifyGroundDimensions(polygon: GeoJSON.Polygon): { width: number; height: number } {
  const coords = polygon.coordinates[0];

  // Bottom-left and bottom-right corners (for width)
  const bottomLeft = coords[0];
  const bottomRight = coords[1];

  // Bottom-left and top-left corners (for height)
  const topLeft = coords[3];

  // Transform to WGS84 for geodesic calculation
  const blWgs84 = transform(bottomLeft, "EPSG:3857", "EPSG:4326");
  const brWgs84 = transform(bottomRight, "EPSG:3857", "EPSG:4326");
  const tlWgs84 = transform(topLeft, "EPSG:3857", "EPSG:4326");

  // Use OpenLayers geodesic distance calculation
  const width = getDistance(blWgs84, brWgs84);
  const height = getDistance(blWgs84, tlWgs84);

  return { width, height };
}

/**
 * Get the target ground size for a given patch resolution.
 *
 * @param resolutionCm - Resolution in cm (5, 10, or 20)
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
