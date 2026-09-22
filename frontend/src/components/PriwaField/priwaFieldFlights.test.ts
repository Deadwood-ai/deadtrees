import { describe, expect, it } from "vitest";

import {
  buildPriwaFlightListItems,
  formatPriwaAreaKm2,
  formatPriwaMebibytes,
  orderPriwaVisibleFlights,
  resolvePriwaFieldFlightRestore,
  resolvePriwaFieldFlightVisibility,
  shouldDeferPriwaInitialPointsFit,
} from "./priwaFieldFlights";
import { resolvePriwaFieldLayout } from "./priwaFieldLayout";
import type { IPriwaOfflineMosaic } from "./priwaOfflineMosaics";
import type { IPriwaMosaic } from "./usePriwaMosaics";

const mosaic = (
  id: string,
  captureDate: string | null,
  overrides: Partial<IPriwaMosaic> = {},
): IPriwaMosaic => ({
  id,
  projectId: "project-1",
  label: `Flug ${id}`,
  cogUrl: `/cogs/${id}.tif`,
  bbox: "BOX(8.1 48.4,8.2 48.5)",
  captureDate,
  createdAt: "2026-08-01T00:00:00.000Z",
  authors: ["PRIWA"],
  additionalInformation: null,
  flightType: null,
  ...overrides,
});

const offlineEntry = (id: string, available: boolean): IPriwaOfflineMosaic => ({
  mosaic: mosaic(id, "2026-07-01"),
  bytes: 200 * 1024 * 1024,
  areaKm2: 1.2,
  etag: null,
  lastModified: null,
  fileName: `${id}.tif`,
  savedAt: "2026-09-01T00:00:00.000Z",
  available,
});

describe("buildPriwaFlightListItems", () => {
  it("lists PRIWA flights newest first and hides excluded uploads", () => {
    const items = buildPriwaFlightListItems({
      mosaics: [
        mosaic("older", "2026-06-01"),
        mosaic("excluded", "2026-09-01", { flightType: "not_priwa" }),
        mosaic("newest", "2026-08-15"),
        mosaic("no-cog", "2026-08-20", { cogUrl: " " }),
      ],
      matchedMosaics: [],
      offlineEntries: [],
      visibleMosaicIds: [],
      isOnline: true,
    });

    expect(items.map((item) => item.mosaic.id)).toEqual(["newest", "older"]);
  });

  it("marks the primary flight, compare flight and matched tree counts", () => {
    const flights = [mosaic("a", "2026-08-01"), mosaic("b", "2026-07-01")];
    const items = buildPriwaFlightListItems({
      mosaics: flights,
      matchedMosaics: [
        {
          mosaic: flights[1],
          points: [{} as never, {} as never, {} as never],
          minDaysApart: 0,
          maxDaysApart: 3,
        },
      ],
      offlineEntries: [],
      visibleMosaicIds: ["b", "a"],
      isOnline: true,
    });

    expect(
      items.map((item) => [item.mosaic.id, item.isPrimary, item.isVisible]),
    ).toEqual([
      ["a", false, true],
      ["b", true, true],
    ]);
    expect(items[1].matchedTreeCount).toBe(3);
  });

  it("only treats complete offline copies as available without network", () => {
    const items = buildPriwaFlightListItems({
      mosaics: [
        mosaic("saved", "2026-08-01"),
        mosaic("partial", "2026-07-01"),
        mosaic("online-only", "2026-06-01"),
      ],
      matchedMosaics: [],
      offlineEntries: [
        offlineEntry("saved", true),
        offlineEntry("partial", false),
      ],
      visibleMosaicIds: [],
      isOnline: false,
    });

    expect(items.map((item) => [item.mosaic.id, item.isAvailable])).toEqual([
      ["saved", true],
      ["partial", false],
      ["online-only", false],
    ]);
    expect(items[1].offlineEntry?.available).toBe(false);
  });
});

describe("resolvePriwaFieldFlightVisibility", () => {
  it("shows exactly one flight by default", () => {
    expect(resolvePriwaFieldFlightVisibility(["a", "b"], "c", "show")).toEqual([
      "c",
    ]);
  });

  it("adds a comparison flight behind the primary one and caps at two", () => {
    expect(resolvePriwaFieldFlightVisibility(["a"], "b", "compare")).toEqual([
      "a",
      "b",
    ]);
    expect(
      resolvePriwaFieldFlightVisibility(["a", "b"], "c", "compare"),
    ).toEqual(["a", "c"]);
    expect(resolvePriwaFieldFlightVisibility([], "c", "compare")).toEqual([
      "c",
    ]);
  });

  it("toggles a compared flight off and hides flights explicitly", () => {
    expect(
      resolvePriwaFieldFlightVisibility(["a", "b"], "b", "compare"),
    ).toEqual(["a"]);
    expect(resolvePriwaFieldFlightVisibility(["a", "b"], "a", "hide")).toEqual([
      "b",
    ]);
  });
});

describe("restoring the remembered flight", () => {
  it("restores the remembered flight once it is available online or from the cache", () => {
    expect(
      resolvePriwaFieldFlightRestore({
        isOnline: true,
        persistedMosaicId: "saved",
        availableMosaicIds: ["other", "saved"],
        hasVisibleFlights: false,
      }),
    ).toBe("saved");
  });

  it("does not restore a missing flight or override a manual choice", () => {
    expect(
      resolvePriwaFieldFlightRestore({
        isOnline: true,
        persistedMosaicId: "gone",
        availableMosaicIds: ["other"],
        hasVisibleFlights: false,
      }),
    ).toBeNull();
    expect(
      resolvePriwaFieldFlightRestore({
        isOnline: true,
        persistedMosaicId: "saved",
        availableMosaicIds: ["saved"],
        hasVisibleFlights: true,
      }),
    ).toBeNull();
    expect(
      resolvePriwaFieldFlightRestore({
        isOnline: true,
        persistedMosaicId: null,
        availableMosaicIds: ["saved"],
        hasVisibleFlights: false,
      }),
    ).toBeNull();
  });

  it("opens an available saved flight offline when the remembered flight is unavailable", () => {
    expect(
      resolvePriwaFieldFlightRestore({
        isOnline: false,
        persistedMosaicId: "online-only",
        availableMosaicIds: ["saved"],
        hasVisibleFlights: false,
      }),
    ).toBe("saved");
  });

  it("defers the initial tree fit only while a remembered flight may still load", () => {
    expect(
      shouldDeferPriwaInitialPointsFit({
        hasPersistedFlight: true,
        hasAttemptedRestore: false,
        isLoadingFlights: true,
      }),
    ).toBe(true);
    expect(
      shouldDeferPriwaInitialPointsFit({
        hasPersistedFlight: true,
        hasAttemptedRestore: true,
        isLoadingFlights: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferPriwaInitialPointsFit({
        hasPersistedFlight: false,
        hasAttemptedRestore: false,
        isLoadingFlights: true,
      }),
    ).toBe(false);
    expect(
      shouldDeferPriwaInitialPointsFit({
        hasPersistedFlight: true,
        hasAttemptedRestore: false,
        isLoadingFlights: false,
      }),
    ).toBe(false);
  });
});

describe("orderPriwaVisibleFlights", () => {
  it("puts the selected flight first", () => {
    expect(orderPriwaVisibleFlights(new Set(["b", "a"]), "a")).toEqual([
      "a",
      "b",
    ]);
    expect(orderPriwaVisibleFlights(new Set(["b"]), null)).toEqual(["b"]);
  });
});

describe("resolvePriwaFieldLayout", () => {
  it("uses the field layout on touch devices and below the workbench width", () => {
    expect(
      resolvePriwaFieldLayout({
        viewportWidth: 1366,
        viewportHeight: 1024,
        isCoarsePointer: true,
      }),
    ).toMatchObject({ isFieldLayout: true, flightPanelPlacement: "side" });
    expect(
      resolvePriwaFieldLayout({
        viewportWidth: 1024,
        viewportHeight: 768,
        isCoarsePointer: false,
      }),
    ).toMatchObject({ isFieldLayout: true, flightPanelPlacement: "side" });
    expect(
      resolvePriwaFieldLayout({
        viewportWidth: 1440,
        viewportHeight: 900,
        isCoarsePointer: false,
      }),
    ).toMatchObject({ isFieldLayout: false });
  });

  it("opens the flight list as a bottom sheet in portrait and on small landscapes", () => {
    expect(
      resolvePriwaFieldLayout({
        viewportWidth: 390,
        viewportHeight: 844,
        isCoarsePointer: true,
      }),
    ).toMatchObject({ flightPanelPlacement: "sheet", isLandscape: false });
    expect(
      resolvePriwaFieldLayout({
        viewportWidth: 600,
        viewportHeight: 360,
        isCoarsePointer: true,
      }),
    ).toMatchObject({ flightPanelPlacement: "sheet", isLandscape: true });
    expect(
      resolvePriwaFieldLayout({
        viewportWidth: 844,
        viewportHeight: 390,
        isCoarsePointer: true,
      }),
    ).toMatchObject({ flightPanelPlacement: "side" });
  });
});

describe("offline size formatting", () => {
  it("formats MiB and km² in German notation", () => {
    expect(formatPriwaMebibytes(312 * 1024 * 1024)).toBe("312 MiB");
    expect(formatPriwaMebibytes(2.5 * 1024 * 1024)).toBe("2,5 MiB");
    expect(formatPriwaAreaKm2(1.84)).toBe("1,8 km²");
    expect(formatPriwaAreaKm2(0.456)).toBe("0,46 km²");
  });
});
