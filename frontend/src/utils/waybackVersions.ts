/**
 * Esri World Imagery Wayback utilities
 *
 * Uses @esri/wayback-core for dynamic version fetching.
 * This file provides helper functions for tile URL generation.
 *
 * Source: https://github.com/Esri/wayback-core
 */

/**
 * Create Esri Wayback tile URL for OpenLayers XYZ source
 * @param releaseNum - The release number from WaybackItem
 */
export const getWaybackTileUrl = (releaseNum: number): string => {
  return `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${releaseNum}/{z}/{y}/{x}`;
};
