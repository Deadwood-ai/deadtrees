import { describe, expect, it } from "vitest";

import { clampPriwaPointPanelWidth } from "./PriwaPointPanelResizeHandle";

describe("clampPriwaPointPanelWidth", () => {
  it("keeps the panel usable and inside the viewport", () => {
    expect(clampPriwaPointPanelWidth(320, 1200)).toBe(560);
    expect(clampPriwaPointPanelWidth(720, 1200)).toBe(720);
    expect(clampPriwaPointPanelWidth(1400, 1200)).toBe(1168);
  });
});
