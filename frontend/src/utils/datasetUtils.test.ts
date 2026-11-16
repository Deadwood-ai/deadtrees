import { describe, expect, it } from "vitest";

import { formatGroundResolution, formatOrthoFileSize } from "./datasetUtils";

describe("formatOrthoFileSize", () => {
  it("shows an unavailable state when failed processing produced no orthomosaic", () => {
    expect(formatOrthoFileSize(null)).toBe("Not available");
  });

  it("formats orthomosaic sizes stored in megabytes", () => {
    expect(formatOrthoFileSize(768)).toBe("768 MB");
    expect(formatOrthoFileSize(1536)).toBe("1.5 GB");
  });
});

describe("formatGroundResolution", () => {
  it("shows centimetres per pixel, metres from one metre, and an unavailable state", () => {
    expect(formatGroundResolution(2.26)).toBe("2.3 cm/px");
    expect(formatGroundResolution(150)).toBe("1.5 m/px");
    expect(formatGroundResolution(null)).toBe("Not available");
  });
});
