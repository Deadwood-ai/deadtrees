import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { inspectGeoTiffAiEligibility, validateGeoTiffAiEligibility } from "./fileValidation";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../test/fixtures/geotiff/upload-validation");

class FileReaderPolyfill {
  public result: ArrayBuffer | null = null;
  public onload: ((event: { target: FileReaderPolyfill }) => void) | null = null;
  public onerror: ((error: unknown) => void) | null = null;
  public onabort: ((error: unknown) => void) | null = null;

  public abort(): void {
    this.onabort?.(new Error("aborted"));
  }

  public readAsArrayBuffer(blob: Blob): void {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onload?.({ target: this });
      })
      .catch((error) => {
        this.onerror?.(error);
      });
  }
}

const loadFixture = async (name: string): Promise<Blob> => {
  const buffer = await readFile(path.join(fixturesDir, name));
  return new Blob([buffer], { type: "image/tiff" });
};

beforeAll(() => {
  vi.stubGlobal("FileReader", FileReaderPolyfill);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("inspectGeoTiffAiEligibility", () => {
  it("accepts RGB fixtures derived from the real archive", async () => {
    const inspection = await inspectGeoTiffAiEligibility(await loadFixture("rgb-real-crop.tif"));

    expect(inspection.supportsAiSegmentation).toBe(true);
    expect(inspection.samplesPerPixel).toBe(3);
    expect([2, 6]).toContain(inspection.photometricInterpretation);
    expect(["RGB", "RGB-compatible YCbCr"]).toContain(inspection.colorModel);
  });

  it("accepts RGBA fixtures derived from the real archive", async () => {
    const inspection = await inspectGeoTiffAiEligibility(await loadFixture("rgba-real-crop.tif"));

    expect(inspection.supportsAiSegmentation).toBe(true);
    expect(inspection.samplesPerPixel).toBe(4);
    expect(inspection.photometricInterpretation).toBe(2);
    expect(inspection.colorModel).toBe("RGBA");
  });

  it("rejects red plus alpha fixtures derived from the real archive", async () => {
    const inspection = await inspectGeoTiffAiEligibility(await loadFixture("red-alpha-real-crop.tif"));

    expect(inspection.supportsAiSegmentation).toBe(false);
    expect(inspection.samplesPerPixel).toBe(2);
    expect(inspection.photometricInterpretation).toBe(1);
    expect(inspection.colorModel).toBe("single-band imagery with alpha");
  });

  it("rejects NIR plus alpha fixtures derived from the real archive", async () => {
    const inspection = await inspectGeoTiffAiEligibility(await loadFixture("nir-alpha-real-crop.tif"));

    expect(inspection.supportsAiSegmentation).toBe(false);
    expect(inspection.samplesPerPixel).toBe(2);
    expect(inspection.photometricInterpretation).toBe(1);
    expect(inspection.colorModel).toBe("single-band imagery with alpha");
  });
});

describe("validateGeoTiffAiEligibility", () => {
  it("raises a user-facing error for unsupported TIFFs", async () => {
    await expect(validateGeoTiffAiEligibility(await loadFixture("nir-alpha-real-crop.tif"))).rejects.toThrow(
      /require an RGB orthomosaic/i,
    );
  });

  it("raises a user-facing error for invalid TIFFs", async () => {
    await expect(validateGeoTiffAiEligibility(new Blob(["not-a-tiff"]))).rejects.toThrow(
      /could not inspect this geotiff/i,
    );
  });
});
