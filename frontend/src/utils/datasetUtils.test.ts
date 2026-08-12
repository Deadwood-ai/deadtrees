import { describe, expect, it } from "vitest";

import { formatOrthoFileSize } from "./datasetUtils";

describe("formatOrthoFileSize", () => {
  it("shows an unavailable state when failed processing produced no orthomosaic", () => {
    expect(formatOrthoFileSize(null)).toBe("Not available");
  });

  it("formats orthomosaic sizes stored in megabytes", () => {
    expect(formatOrthoFileSize(768)).toBe("768 MB");
    expect(formatOrthoFileSize(1536)).toBe("1.5 GB");
  });
});
