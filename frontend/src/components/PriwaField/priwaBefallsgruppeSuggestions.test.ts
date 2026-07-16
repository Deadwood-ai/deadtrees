import { describe, expect, it } from "vitest";

import type { IPriwaPoint } from "./types";
import {
  PRIWA_BEFALLSGRUPPE_MAX_DATE_DAYS,
  PRIWA_BEFALLSGRUPPE_MAX_DISTANCE_METERS,
  suggestPriwaBefallsgruppen,
} from "./priwaBefallsgruppeSuggestions";

const point = (
  id: string,
  lon: number,
  datum = "2026-07-10",
  name: IPriwaPoint["name"] = "Sigi Huber",
): IPriwaPoint => ({
  id,
  lat: 48.45,
  lon,
  baumnr: id,
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name,
  datum,
  kom: "",
  capturedAt: `${datum}T08:00:00.000Z`,
  coordinateSource: "qr",
  gps: "ja",
});

describe("suggestPriwaBefallsgruppen", () => {
  it("clusters nearby trees even when different people recorded them", () => {
    const suggestions = suggestPriwaBefallsgruppen([
      point("1", 8.15, "2026-07-10", "Sigi Huber"),
      point("2", 8.1502, "2026-07-10", "Fabian Bohnert"),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].treeIds).toEqual(["1", "2"]);
    expect(suggestions[0].confidence).toBeGreaterThanOrEqual(0.65);
  });

  it("keeps spatially distant or temporally distant trees separate", () => {
    expect(
      suggestPriwaBefallsgruppen([point("near", 8.15), point("far", 8.151)]),
    ).toEqual([]);

    expect(
      suggestPriwaBefallsgruppen([
        point("early", 8.15, "2026-07-01"),
        point("late", 8.1501, "2026-07-09"),
      ]),
    ).toEqual([]);
  });

  it("does not suggest trees that already have a confirmed membership", () => {
    const suggestions = suggestPriwaBefallsgruppen(
      [
        point("confirmed", 8.15),
        point("candidate-1", 8.1501),
        point("candidate-2", 8.1502),
      ],
      new Set(["confirmed"]),
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].treeIds).toEqual(["candidate-1", "candidate-2"]);
  });

  it("does not create date-window chains wider than the configured limit", () => {
    const suggestions = suggestPriwaBefallsgruppen([
      point("day-1", 8.15, "2026-07-01"),
      point("day-8", 8.1501, "2026-07-08"),
      point("day-15", 8.1502, "2026-07-15"),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].treeIds).toEqual(["day-1", "day-8"]);
    expect(suggestions[0].maxDateSpanDays).toBe(7);
  });

  it("uses documented configurable limits", () => {
    expect(PRIWA_BEFALLSGRUPPE_MAX_DISTANCE_METERS).toBe(30);
    expect(PRIWA_BEFALLSGRUPPE_MAX_DATE_DAYS).toBe(7);
  });
});
