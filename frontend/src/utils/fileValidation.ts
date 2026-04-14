import { UploadType } from "../types/dataset";
import { unzipRaw } from "unzipit";
import { fromBlob } from "geotiff";

export const detectUploadType = (fileName: string): UploadType => {
  const ext = fileName.toLowerCase().split(".").pop();
  if (["tif", "tiff"].includes(ext || "")) {
    return UploadType.GEOTIFF;
  } else if (ext === "zip") {
    return UploadType.RAW_IMAGES_ZIP;
  }
  throw new Error(`Unsupported file type: ${ext}`);
};

export const validateFileSize = (file: File, uploadType: UploadType): boolean => {
  const MAX_ZIP_SIZE = 30 * 1024 * 1024 * 1024; // 30GB
  const MAX_GEOTIFF_SIZE = 20 * 1024 * 1024 * 1024; // 20GB

  if (uploadType === UploadType.RAW_IMAGES_ZIP && file.size > MAX_ZIP_SIZE) {
    throw new Error("ZIP files must be smaller than 30GB");
  }
  if (uploadType === UploadType.GEOTIFF && file.size > MAX_GEOTIFF_SIZE) {
    throw new Error("GeoTIFF files must be smaller than 20GB");
  }
  return true;
};

const RGB_PHOTOMETRIC_INTERPRETATION = 2;
const YCBCR_PHOTOMETRIC_INTERPRETATION = 6;

const getNumericTagValue = (value: unknown): number | null => {
  if (typeof value === "number") {
    return value;
  }

  if (ArrayBuffer.isView(value) && value.byteLength > 0 && "0" in value) {
    return Number(value[0]);
  }

  return null;
};

const describeColorModel = (samplesPerPixel: number, photometricInterpretation: number | null): string => {
  if (photometricInterpretation === RGB_PHOTOMETRIC_INTERPRETATION && samplesPerPixel === 3) {
    return "RGB";
  }

  if (photometricInterpretation === RGB_PHOTOMETRIC_INTERPRETATION && samplesPerPixel >= 4) {
    return "RGBA";
  }

  if (photometricInterpretation === YCBCR_PHOTOMETRIC_INTERPRETATION && samplesPerPixel >= 3) {
    return "RGB-compatible YCbCr";
  }

  if (photometricInterpretation === 1 && samplesPerPixel === 1) {
    return "single-band grayscale";
  }

  if (photometricInterpretation === 1 && samplesPerPixel === 2) {
    return "single-band imagery with alpha";
  }

  return `${samplesPerPixel}-sample imagery`;
};

const getBandDescriptions = (image: {
  getGDALMetadata?: (sample?: number | null) => Record<string, string> | null;
}, samplesPerPixel: number): string[] => {
  const descriptions: string[] = [];

  if (!image.getGDALMetadata) {
    return descriptions;
  }

  for (let sampleIndex = 0; sampleIndex < samplesPerPixel; sampleIndex += 1) {
    const metadata = image.getGDALMetadata(sampleIndex);
    const description = metadata?.DESCRIPTION ?? metadata?.COLORINTERP;
    if (description) {
      descriptions.push(description.trim().toLowerCase());
    }
  }

  return descriptions;
};

export interface GeoTiffAiEligibility {
  supportsAiSegmentation: boolean;
  samplesPerPixel: number;
  photometricInterpretation: number | null;
  colorModel: string;
}

export const inspectGeoTiffAiEligibility = async (file: Blob): Promise<GeoTiffAiEligibility> => {
  try {
    // This inspects TIFF header/IFD metadata only. It does not read raster pixels into memory.
    const tiff = await fromBlob(file);
    const image = await tiff.getImage();
    const samplesPerPixel = image.getSamplesPerPixel();
    const photometricInterpretation = getNumericTagValue(image.fileDirectory.PhotometricInterpretation);
    const bandDescriptions = getBandDescriptions(image, samplesPerPixel);
    const hasRgbBandDescriptions =
      bandDescriptions[0] === "red" && bandDescriptions[1] === "green" && bandDescriptions[2] === "blue";
    const supportsAiSegmentation =
      samplesPerPixel >= 3 &&
      (
        photometricInterpretation === RGB_PHOTOMETRIC_INTERPRETATION ||
        photometricInterpretation === YCBCR_PHOTOMETRIC_INTERPRETATION ||
        hasRgbBandDescriptions
      );

    return {
      supportsAiSegmentation,
      samplesPerPixel,
      photometricInterpretation,
      colorModel: describeColorModel(samplesPerPixel, photometricInterpretation),
    };
  } catch {
    throw new Error("We could not inspect this GeoTIFF. Please choose a valid GeoTIFF file.");
  }
};

export const validateGeoTiffAiEligibility = async (file: Blob): Promise<GeoTiffAiEligibility> => {
  const inspection = await inspectGeoTiffAiEligibility(file);

  if (!inspection.supportsAiSegmentation) {
    throw new Error(
      `We cannot process this dataset yet. Deadwood and tree cover currently require an RGB orthomosaic, but this file looks like ${inspection.colorModel}.`,
    );
  }

  return inspection;
};

const ALLOWED_ZIP_METHODS = new Set([0, 8]); // stored, deflate
const ALLOWED_ZIP_METHODS_TEXT = "stored (method 0), deflate (method 8)";

type ZipEntryWithCompressionMethod = {
  compressionMethod?: number;
};

const methodName = (method: number): string => {
  switch (method) {
    case 0:
      return "stored";
    case 8:
      return "deflate";
    case 9:
      return "deflate64";
    case 12:
      return "bzip2";
    case 14:
      return "lzma";
    default:
      return `method-${method}`;
  }
};

export const validateZipCompressionMethods = async (file: File): Promise<void> => {
  let entries: ZipEntryWithCompressionMethod[] = [];
  try {
    const zipInfo = await unzipRaw(file);
    entries = zipInfo.entries as ZipEntryWithCompressionMethod[];
  } catch {
    throw new Error("Invalid ZIP archive");
  }

  const methodCounts = new Map<number, number>();

  for (const entry of entries) {
    const compressionMethod = entry.compressionMethod;
    if (typeof compressionMethod !== "number") {
      throw new Error("Unable to inspect ZIP compression methods");
    }
    methodCounts.set(compressionMethod, (methodCounts.get(compressionMethod) ?? 0) + 1);
  }

  const unsupported = [...methodCounts.entries()].filter(([method]) => !ALLOWED_ZIP_METHODS.has(method));
  if (unsupported.length > 0) {
    const formatted = unsupported
      .map(([method, count]) => `${methodName(method)} (method ${method}, ${count} file(s))`)
      .join(", ");
    throw new Error(
      `Unsupported ZIP compression method(s): ${formatted}. Please re-compress the ZIP using one of: ${ALLOWED_ZIP_METHODS_TEXT}.`,
    );
  }
};
