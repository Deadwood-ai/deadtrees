import { describe, expect, it } from "vitest";

import { escapeCsvCell } from "./csvCell";

describe("escapeCsvCell", () => {
  it("quotes text and doubles quotes", () => {
    expect(escapeCsvCell('Norway "spruce"')).toBe('"Norway ""spruce"""');
  });

  it.each(["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "neutralizes text a spreadsheet would run: %s",
    (text) => {
      expect(escapeCsvCell(text).startsWith("\"'")).toBe(true);
    },
  );

  it("keeps numbers, booleans and empty values as they are", () => {
    expect(escapeCsvCell(-8.654321)).toBe('"-8.654321"');
    expect(escapeCsvCell(false)).toBe('"false"');
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });
});
