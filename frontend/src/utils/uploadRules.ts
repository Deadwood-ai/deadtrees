// Upload rules checked in the browser before any bytes are sent.
// Rejections mirror `shared/upload_validation.py`, which the API applies when an
// upload completes; keep the two in step. Warnings are browser-only: they flag
// uploads that often fail but sometimes succeed, so they never block.

const RAW_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".dng",
  ".raw",
  ".bmp",
  ".webp",
]);
const RAW_CAMERA_EXTENSIONS = new Set([".dng", ".raw"]);
const TIFF_EXTENSIONS = new Set([".tif", ".tiff"]);

// Fewer photos than this rarely produce an orthomosaic (12 of 45 past uploads did).
const RECOMMENDED_MIN_PHOTOS = 10;

// Single-band captures from DJI Mavic 3M (`*_MS_G.TIF`) and Parrot Sequoia (`*_GRE.TIF`).
const MULTISPECTRAL_BAND = /(_MS_)|(_(GRE|NIR|RED|REG)\.TIFF?$)/i;

const baseName = (name: string) => name.split("/").pop() ?? name;

const extension = (name: string) => {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
};

export const isMultispectralBand = (name: string) =>
  MULTISPECTRAL_BAND.test(baseName(name));

const rawImageNames = (entryNames: string[]) =>
  entryNames.filter(
    (name) =>
      !name.endsWith("/") &&
      !name.includes("__MACOSX") &&
      !baseName(name).startsWith("._") &&
      RAW_IMAGE_EXTENSIONS.has(extension(name)),
  );

/** Throws for a ZIP that cannot process; returns warnings for a risky one. */
export const checkRawImageNames = (entryNames: string[]): string[] => {
  const images = rawImageNames(entryNames);
  const rgbImages = images.filter((name) => !isMultispectralBand(name));

  if (rgbImages.length === 0 && images.length > 0) {
    throw new Error(
      "This ZIP only contains multispectral band images (for example *_MS_G.TIF or *_NIR.TIF). " +
        "deadtrees.earth needs the RGB photos from the flight. " +
        "Add the RGB JPGs, or upload an RGB orthomosaic as a GeoTIFF.",
    );
  }
  if (rgbImages.length === 0) {
    throw new Error(
      "This ZIP contains no drone photos we can process (JPG, PNG, TIFF or DNG). " +
        "Check that the photos are inside the archive.",
    );
  }
  // A JPG and its DNG twin are one photo; the processor drops the DNG.
  const photoCount = new Set(
    rgbImages.map((name) =>
      name.slice(0, name.length - extension(name).length).toLowerCase(),
    ),
  ).size;
  if (photoCount === 1) {
    throw new Error(
      "This ZIP contains only one image, and an orthomosaic needs many overlapping photos. " +
        "If this image is already an orthomosaic, upload the .tif file directly as a GeoTIFF.",
    );
  }

  const warnings: string[] = [];
  if (photoCount < RECOMMENDED_MIN_PHOTOS) {
    const allTiff = rgbImages.every((name) =>
      TIFF_EXTENSIONS.has(extension(name)),
    );
    warnings.push(
      `This ZIP has only ${photoCount} photos. An orthomosaic usually needs at least ` +
        `${RECOMMENDED_MIN_PHOTOS} overlapping photos, so processing will probably fail.` +
        (allTiff
          ? " If these files are already orthomosaics, upload each .tif directly as a GeoTIFF."
          : ""),
    );
  }
  if (rgbImages.every((name) => RAW_CAMERA_EXTENSIONS.has(extension(name)))) {
    warnings.push(
      "This ZIP only contains raw DNG photos, which often fail to process. " +
        "If your camera also saved JPGs, add them to the ZIP.",
    );
  }
  return warnings;
};

// GeoTIFF GeoKey values (OGC GeoTIFF 1.1).
const USER_DEFINED = 32767;
const NON_CRS_GEOKEYS = new Set(["GTRasterTypeGeoKey", "GTCitationGeoKey"]);

export interface GeoTiffGeoreference {
  geoKeys: Record<string, unknown> | null;
  hasCoordinates: boolean;
}

// Rejects only a file with no CRS-related GeoKey at all, which the processor always refuses.
// The API repeats the authoritative GDAL check when the upload completes.
export const checkGeoTiffGeoreference = ({
  geoKeys,
  hasCoordinates,
}: GeoTiffGeoreference): string[] => {
  const modelType = geoKeys?.GTModelTypeGeoKey;
  // Any GeoKey beyond the raster type and free-text citation may describe a CRS; GDAL decides on upload.
  const hasCrs = Object.keys(geoKeys ?? {}).some(
    (key) => !NON_CRS_GEOKEYS.has(key),
  );

  if (!hasCrs && hasCoordinates) {
    throw new Error(
      "This GeoTIFF has coordinates but no coordinate system (CRS), so we cannot place it on the map. " +
        "Re-export it with the CRS embedded (for example EPSG:25832).",
    );
  }
  if (!hasCrs) {
    throw new Error(
      "This file has no location information (no CRS or georeferencing). " +
        "Upload a georeferenced orthomosaic as a GeoTIFF with its CRS embedded.",
    );
  }

  const warnings: string[] = [];
  if (
    modelType === USER_DEFINED ||
    geoKeys?.ProjectedCSTypeGeoKey === USER_DEFINED
  ) {
    warnings.push(
      "This GeoTIFF uses a custom or local coordinate system. We will check it after upload; " +
        "if processing fails, re-export it with a standard EPSG code.",
    );
  }
  return warnings;
};
