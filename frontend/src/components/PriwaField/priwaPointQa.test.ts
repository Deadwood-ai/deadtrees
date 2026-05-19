import { describe, expect, it } from "vitest";

import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
  isPriwaPointQaCandidate,
} from "./priwaPointQa";
import type { IPriwaPoint } from "./types";

const basePoint: IPriwaPoint = {
  id: "point-1",
  lat: 48.45596,
  lon: 8.18013,
  baumnr: "42",
  fund: "ja",
  baumart: "Fichte",
  bm: "nein",
  bohrloch: "nein",
  harz: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "andere",
  datum: "2026-05-19",
  kom: "",
  capturedAt: "2026-05-19T12:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
};

describe("PRIWA point QA helpers", () => {
  it("does not flag QR points with a tree number", () => {
    expect(isPriwaPointQaCandidate(basePoint)).toBe(false);
  });

  it("flags estimated locations and missing tree numbers for QA", () => {
    expect(
      isPriwaPointQaCandidate({ ...basePoint, coordinateSource: "gps" }),
    ).toBe(true);
    expect(isPriwaPointQaCandidate({ ...basePoint, baumnr: " " })).toBe(true);
  });

  it("formats list labels from point state", () => {
    expect(getPriwaPointSourceLabel(basePoint)).toBe("QR");
    expect(getPriwaFundLabel({ ...basePoint, fund: "ja_kein_buchdrucker" }))
      .toBe("Ja, kein Buchdrucker");
    expect(getPriwaPointTitle({ ...basePoint, baumnr: "" })).toBe(
      "Ohne Baumnr · 2026-05-19",
    );
  });
});
