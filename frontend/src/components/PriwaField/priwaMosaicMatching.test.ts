import { describe, expect, it } from "vitest";

import type { IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import {
  PRIWA_MOSAIC_MATCH_MAX_DAYS,
  matchPriwaPointsToMosaics,
} from "./priwaMosaicMatching";

const point = (overrides: Partial<IPriwaPoint> = {}): IPriwaPoint => ({
  id: "point-1",
  lat: 48.45,
  lon: 8.15,
  baumnr: "101",
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "andere",
  datum: "2026-06-15",
  kom: "",
  capturedAt: "2026-06-15T08:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
  ...overrides,
});

const mosaic = (overrides: Partial<IPriwaMosaic> = {}): IPriwaMosaic => ({
  id: "mosaic-1",
  projectId: "project-1",
  label: "PRIWA flight",
  cogUrl: "uploads/priwa-flight-cog.tif",
  bbox: "BOX(8.10 48.40,8.20 48.50)",
  captureDate: "2026-06-17",
  createdAt: "2026-06-18T08:00:00.000Z",
  authors: ["PRIWA"],
  additionalInformation: null,
  ...overrides,
});

describe("matchPriwaPointsToMosaics", () => {
  it("matches a point inside the bbox to a nearby acquisition date", () => {
    expect(matchPriwaPointsToMosaics([point()], [mosaic()])).toEqual([
      {
        pointId: "point-1",
        mosaicId: "mosaic-1",
        daysApart: 2,
      },
    ]);
  });

  it("includes points on bbox boundaries and excludes points outside", () => {
    const boundaryPoint = point({ id: "boundary", lon: 8.1, lat: 48.4 });
    const outsidePoint = point({ id: "outside", lon: 8.099, lat: 48.4 });

    expect(
      matchPriwaPointsToMosaics([boundaryPoint, outsidePoint], [mosaic()]),
    ).toEqual([
      {
        pointId: "boundary",
        mosaicId: "mosaic-1",
        daysApart: 2,
      },
    ]);
  });

  it("includes the 30-day boundary and rejects more distant flights", () => {
    const withinWindow = mosaic({ id: "within", captureDate: "2026-07-15" });
    const outsideWindow = mosaic({ id: "outside", captureDate: "2026-07-16" });

    expect(
      matchPriwaPointsToMosaics(
        [point()],
        [outsideWindow, withinWindow],
        PRIWA_MOSAIC_MATCH_MAX_DAYS,
      ),
    ).toEqual([
      {
        pointId: "point-1",
        mosaicId: "within",
        daysApart: 30,
      },
    ]);
  });

  it("chooses the closest acquisition date when multiple COGs overlap", () => {
    const fiveDaysBefore = mosaic({
      id: "before",
      captureDate: "2026-06-10",
    });
    const oneDayAfter = mosaic({ id: "after", captureDate: "2026-06-16" });

    expect(
      matchPriwaPointsToMosaics([point()], [fiveDaysBefore, oneDayAfter]),
    ).toEqual([
      {
        pointId: "point-1",
        mosaicId: "after",
        daysApart: 1,
      },
    ]);
  });

  it("uses newer acquisition and upload dates as deterministic tie-breakers", () => {
    const olderCapture = mosaic({
      id: "older-capture",
      captureDate: "2026-06-14",
      createdAt: "2026-06-20T00:00:00.000Z",
    });
    const newerCaptureOlderUpload = mosaic({
      id: "newer-capture-old-upload",
      captureDate: "2026-06-16",
      createdAt: "2026-06-17T00:00:00.000Z",
    });
    const newerCaptureNewerUpload = mosaic({
      id: "newer-capture-new-upload",
      captureDate: "2026-06-16",
      createdAt: "2026-06-18T00:00:00.000Z",
    });

    expect(
      matchPriwaPointsToMosaics(
        [point()],
        [olderCapture, newerCaptureOlderUpload, newerCaptureNewerUpload],
      ),
    ).toEqual([
      {
        pointId: "point-1",
        mosaicId: "newer-capture-new-upload",
        daysApart: 1,
      },
    ]);
  });

  it("uses natural ID ordering when dates tie", () => {
    const lowerId = mosaic({ id: "flight-2" });
    const higherId = mosaic({ id: "flight-10" });

    expect(matchPriwaPointsToMosaics([point()], [lowerId, higherId])).toEqual([
      {
        pointId: "point-1",
        mosaicId: "flight-10",
        daysApart: 2,
      },
    ]);
  });

  it("can associate several points with the same COG", () => {
    expect(
      matchPriwaPointsToMosaics(
        [point(), point({ id: "point-2", datum: "2026-06-18" })],
        [mosaic()],
      ),
    ).toEqual([
      { pointId: "point-1", mosaicId: "mosaic-1", daysApart: 2 },
      { pointId: "point-2", mosaicId: "mosaic-1", daysApart: 1 },
    ]);
  });

  it("skips malformed or incomplete spatial and date metadata", () => {
    expect(
      matchPriwaPointsToMosaics(
        [point(), point({ id: "bad-date-point", datum: "not-a-date" })],
        [
          mosaic({ id: "no-bbox", bbox: null }),
          mosaic({ id: "bad-bbox", bbox: "invalid" }),
          mosaic({ id: "no-date", captureDate: null }),
          mosaic({ id: "bad-date", captureDate: "2026-02-31" }),
        ],
      ),
    ).toEqual([]);
  });

  it("compares calendar days without daylight-saving offsets", () => {
    expect(
      matchPriwaPointsToMosaics(
        [point({ datum: "2026-03-28" })],
        [mosaic({ captureDate: "2026-03-30" })],
      ),
    ).toEqual([{ pointId: "point-1", mosaicId: "mosaic-1", daysApart: 2 }]);
  });
});
