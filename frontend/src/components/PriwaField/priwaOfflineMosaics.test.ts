import { describe, expect, it, vi } from "vitest";
import {
  priwaMosaicAreaKm2,
  validatePriwaMosaicPackage,
  type IPriwaOfflineMosaicPlan,
} from "./priwaOfflineMosaicPlan";
import { streamPriwaMosaicFile } from "./priwaOfflineMosaics";
import type { IPriwaMosaic } from "./usePriwaMosaics";

const mosaic: IPriwaMosaic = {
  id: "10512",
  projectId: "project",
  label: "Flight",
  cogUrl: "flight.tif",
  bbox: "BOX(8.18 48.45,8.19 48.46)",
  captureDate: null,
  createdAt: "2026-09-21",
  authors: [],
  additionalInformation: null,
  flightType: null,
};
const plan: IPriwaOfflineMosaicPlan = {
  mosaic,
  bytes: 100_000_000,
  areaKm2: priwaMosaicAreaKm2(mosaic),
  etag: null,
  lastModified: null,
};

describe("complete native-resolution offline packages", () => {
  it("bounds count, complete footprint and bytes independently", () => {
    expect(plan.areaKm2).toBeGreaterThan(0.8);
    expect(plan.areaKm2).toBeLessThan(0.9);
    expect(() => validatePriwaMosaicPackage([plan])).not.toThrow();
    expect(() => validatePriwaMosaicPackage([plan, plan])).toThrow(
      /unterschiedliche/,
    );
    expect(() =>
      validatePriwaMosaicPackage([{ ...plan, bytes: 600 * 1024 * 1024 }]),
    ).toThrow(/500 MiB/);
    expect(() =>
      validatePriwaMosaicPackage([{ ...plan, areaKm2: 3.01 }]),
    ).toThrow(/3 km²/);
    expect(() => validatePriwaMosaicPackage([{ ...plan, bytes: 0 }])).toThrow(
      /Dateigröße/,
    );
    expect(() => priwaMosaicAreaKm2({ ...mosaic, bbox: null })).toThrow(
      /Grenze/,
    );
  });

  const sink = () => {
    const chunks: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (value: Uint8Array) => {
        chunks.push(value);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    return {
      chunks,
      writer,
      stream: writer as unknown as FileSystemWritableFileStream,
    };
  };

  it("writes every source byte and reports completion only after closing the file", async () => {
    const output = sink();
    const progress = vi.fn();
    const bytes = new Uint8Array([73, 73, 42, 0, 22, 33, 44]);
    await streamPriwaMosaicFile(
      new Response(bytes),
      output.stream,
      bytes.length,
      new AbortController().signal,
      progress,
    );
    expect(output.chunks).toEqual([bytes]);
    expect(output.writer.close).toHaveBeenCalledOnce();
    expect(output.writer.abort).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(bytes.length);
  });

  it.each([2, 6])(
    "aborts a truncated or oversized response (expected %s bytes)",
    async (size) => {
      const output = sink();
      await expect(
        streamPriwaMosaicFile(
          new Response(new Uint8Array(4)),
          output.stream,
          size,
          new AbortController().signal,
          vi.fn(),
        ),
      ).rejects.toThrow();
      expect(output.writer.close).not.toHaveBeenCalled();
      expect(output.writer.abort).toHaveBeenCalledOnce();
    },
  );

  it("never treats a range response as a complete source", async () => {
    const output = sink();
    await expect(
      streamPriwaMosaicFile(
        new Response(new Uint8Array(4), { status: 206 }),
        output.stream,
        4,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow(/HTTP 206/);
    expect(output.writer.close).not.toHaveBeenCalled();
  });

  it("preserves cancellation instead of finalizing a partial download", async () => {
    const output = sink();
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamPriwaMosaicFile(
        new Response(new Uint8Array(4)),
        output.stream,
        4,
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(output.writer.close).not.toHaveBeenCalled();
    expect(output.writer.abort).toHaveBeenCalledOnce();
  });
});
