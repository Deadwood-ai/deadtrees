import { describe, expect, it } from "vitest";

import parseBBox from "./parseBBox";

describe("parseBBox", () => {
  it("accepts Postgres BOX coordinates normalized to whole numbers", () => {
    expect(parseBBox("BOX(7.89 47.98,7.91 48)")).toEqual([
      7.89, 47.98, 7.91, 48,
    ]);
  });

  it("accepts negative and decimal coordinates", () => {
    expect(parseBBox("BOX(-8.2 -48.1,-7.9 -47.8)")).toEqual([
      -8.2, -48.1, -7.9, -47.8,
    ]);
  });
});
