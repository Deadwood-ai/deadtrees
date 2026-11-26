import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type ImageTile from "ol/ImageTile";

import {
  createImageryFallbackTileLoadFunction,
  fillUrlTemplate,
  isEsriPlaceholderTile,
} from "./imageryTileFallback";

const TEMPLATE = "https://tiles.test/{z}/{y}/{x}";

// The exact bytes Esri serves for "Map data not yet available".
const placeholderBytes = () =>
  new Uint8Array(
    readFileSync(
      new URL("./__fixtures__/esri-imagery-placeholder.jpg", import.meta.url),
    ),
  );

type FakeBitmap = { width: number; url: string; close: () => void };

const makeTile = (z: number, x: number, y: number) => {
  const image = new EventTarget();
  const tile = {
    getTileCoord: () => [z, x, y],
    getImage: () => image,
    setImage: vi.fn(),
  };
  return {
    tile: tile as unknown as ImageTile & { setImage: typeof tile.setImage },
    image,
  };
};

describe("imagery tile fallback", () => {
  let tiles: Record<string, BlobPart | null>;
  let drawCalls: unknown[][];

  beforeEach(() => {
    tiles = {};
    drawCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!(url in tiles)) throw new TypeError("network error");
        const body = tiles[url];
        return body === null
          ? new Response(null, { status: 404 })
          : new Response(new Blob([body]), { status: 200 });
      }),
    );
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({
      width: 256,
      url: await blob.text(),
      close: vi.fn(),
    }));
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({
          drawImage: (...args: unknown[]) => drawCalls.push(args),
        }),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognises Esri's placeholder tile and nothing else", async () => {
    expect(await isEsriPlaceholderTile(new Blob([placeholderBytes()]))).toBe(
      true,
    );
    expect(await isEsriPlaceholderTile(new Blob(["real imagery"]))).toBe(false);
  });

  it("uses the tile itself when it has imagery", async () => {
    const src = fillUrlTemplate(TEMPLATE, 18, 5, 7);
    tiles[src] = "own";
    const { tile } = makeTile(18, 5, 7);

    createImageryFallbackTileLoadFunction(TEMPLATE)(tile, src);
    await vi.waitFor(() => expect(tile.setImage).toHaveBeenCalled());

    expect(tile.setImage).toHaveBeenCalledTimes(1);
    expect((drawCalls[0][0] as FakeBitmap).url).toBe("own");
    expect(drawCalls[0].slice(1)).toEqual([0, 0, 256, 256, 0, 0, 256, 256]);
  });

  it("upscales the matching quarter of the nearest ancestor with imagery", async () => {
    // z19 is the placeholder, z18 is a 404, z17 has imagery.
    const src = fillUrlTemplate(TEMPLATE, 19, 7, 2);
    tiles[src] = placeholderBytes();
    tiles[fillUrlTemplate(TEMPLATE, 18, 3, 1)] = null;
    tiles[fillUrlTemplate(TEMPLATE, 17, 1, 0)] = "ancestor";
    const { tile } = makeTile(19, 7, 2);

    createImageryFallbackTileLoadFunction(TEMPLATE)(tile, src);
    await vi.waitFor(() => expect(tile.setImage).toHaveBeenCalled());

    expect(tile.setImage).toHaveBeenCalledTimes(1);
    expect((drawCalls[0][0] as FakeBitmap).url).toBe("ancestor");
    // x=7 is the 4th of 4 columns under ancestor x=1; y=2 the 3rd row under y=0.
    expect(drawCalls[0].slice(1)).toEqual([192, 128, 64, 64, 0, 0, 256, 256]);
  });

  it("downloads a shared ancestor once for neighbouring tiles", async () => {
    const load = createImageryFallbackTileLoadFunction(TEMPLATE);
    tiles[fillUrlTemplate(TEMPLATE, 17, 0, 0)] = "ancestor";
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const src = fillUrlTemplate(TEMPLATE, 18, x, y);
      tiles[src] = placeholderBytes();
      load(makeTile(18, x, y).tile, src);
    }
    await vi.waitFor(() => expect(drawCalls).toHaveLength(4));

    const ancestorRequests = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([url]) => url === fillUrlTemplate(TEMPLATE, 17, 0, 0),
      );
    expect(ancestorRequests).toHaveLength(1);
    expect(drawCalls).toHaveLength(4);
  });

  it("reports an error when no ancestor has imagery either", async () => {
    const src = fillUrlTemplate(TEMPLATE, 2, 1, 1);
    tiles[src] = placeholderBytes();
    const { tile, image } = makeTile(2, 1, 1);
    const onError = vi.fn();
    image.addEventListener("error", onError);

    createImageryFallbackTileLoadFunction(TEMPLATE)(tile, src);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    expect(tile.setImage).not.toHaveBeenCalled();
  });
});
