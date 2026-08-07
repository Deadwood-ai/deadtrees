import { describe, expect, it } from "vitest";

import { PriwaWarnkarteApiError } from "../../api/priwaWarnkarte";
import {
  formatPriwaWarnkarteDate,
  formatPriwaWarnkarteError,
} from "./priwaWarnkartePresentation";

describe("PRIWA Warnkarte presentation", () => {
  it("formats the authoritative date for the German label", () => {
    expect(formatPriwaWarnkarteDate("2024-06-25")).toBe("25.06.2024");
  });

  it("shows expected and detected CRS from a structured backend error", () => {
    const error = new PriwaWarnkarteApiError(
      "INVALID_CRS",
      "Das Koordinatenreferenzsystem ist ungültig.",
      { expected: "EPSG:32632", detected: "EPSG:4326" },
    );

    expect(formatPriwaWarnkarteError(error)).toContain("Erwartet: EPSG:32632");
    expect(formatPriwaWarnkarteError(error)).toContain("Erkannt: EPSG:4326");
  });
});
