import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { validateZipUpload } from "./fileValidation";

const fixture = async (name = "mixed-stored.zip") =>
  new Uint8Array(await readFile(new URL(`../../test/fixtures/zip/${name}`, import.meta.url)));
const file = (bytes: Uint8Array<ArrayBuffer>) => new File([bytes], "images.zip");

describe("ZIP validation feedback", () => {
  it.each(["mixed-stored.zip", "mixed-zip64.zip"])("reads %s and checks the photos inside", async (name) => {
    await expect(validateZipUpload(file(await fixture(name)))).rejects.toThrow(/only one image.*upload the \.tif file directly/);
  });

  it("accepts RGB photos next to multispectral bands without warnings", async () => {
    await expect(validateZipUpload(file(await fixture("rgb-photos.zip")))).resolves.toEqual([]);
  });

  it("rejects a ZIP with only multispectral bands before upload", async () => {
    await expect(validateZipUpload(file(await fixture("multispectral-only.zip"))))
      .rejects.toThrow(/only contains multispectral band images.*RGB/);
  });

  it("warns about few photos and DNG-only archives", async () => {
    const warnings = await validateZipUpload(file(await fixture("few-dng.zip")));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/only 3 photos/);
    expect(warnings[1]).toMatch(/raw DNG photos/);
  });

  it("explains missing archive metadata without claiming a known cause", async () => {
    await expect(validateZipUpload(new File(["not a zip"], "images.zip")))
      .rejects.toThrow(/ZIP file index.*incomplete.*ZIP_INDEX_MISSING/);
  });

  it("explains a broken directory offset and suggests ZIP64 for large archives", async () => {
    const bytes = await fixture();
    new DataView(bytes.buffer).setUint32(bytes.length - 6, 0, true);
    await expect(validateZipUpload(file(bytes)))
      .rejects.toThrow(/ZIP file index.*ZIP64.*ZIP_INDEX_INVALID/);
  });

  it("identifies broken ZIP64 metadata", async () => {
    const bytes = await fixture("mixed-zip64.zip");
    bytes[bytes.length - 42] = 0;
    await expect(validateZipUpload(file(bytes)))
      .rejects.toThrow(/ZIP64 metadata.*ZIP64_INVALID/);
  });

  it("identifies split archives", async () => {
    const bytes = await fixture();
    new DataView(bytes.buffer).setUint16(bytes.length - 18, 1, true);
    await expect(validateZipUpload(file(bytes)))
      .rejects.toThrow(/split.*single ZIP.*ZIP_MULTIVOLUME/);
  });

  it("keeps unsupported compression feedback specific", async () => {
    const bytes = await fixture();
    const directory = new DataView(bytes.buffer).getUint32(bytes.length - 6, true);
    new DataView(bytes.buffer).setUint16(directory + 10, 9, true);
    await expect(validateZipUpload(file(bytes))).rejects.toThrow(/deflate64 \(method 9/);
  });

  it("identifies unsupported strong encryption", async () => {
    const bytes = await fixture();
    const directory = new DataView(bytes.buffer).getUint32(bytes.length - 6, true);
    new DataView(bytes.buffer).setUint16(directory + 8, 0x40, true);
    await expect(validateZipUpload(file(bytes)))
      .rejects.toThrow(/encryption.*without a password.*ZIP_ENCRYPTED/);
  });

  it.each(["NotReadableError", "SecurityError", "NotAllowedError", "AbortError"])(
    "distinguishes a browser %s from malformed ZIP metadata",
    async (name) => {
      const read = vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValueOnce(new DOMException("private path", name));
      try {
        await expect(validateZipUpload(file(await fixture())))
          .rejects.toThrow(/browser could not read.*local copy.*ZIP_FILE_READ/);
      } finally {
        read.mockRestore();
      }
    },
  );

  it("keeps unknown failures honest and excludes arbitrary exception text", async () => {
    const read = vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValueOnce(new Error("private path"));
    try {
      await expect(validateZipUpload(file(await fixture())))
        .rejects.toThrow(/^We could not inspect this ZIP.*ZIP_INSPECTION_FAILED\.$/);
    } finally {
      read.mockRestore();
    }
  });
});
