import { describe, expect, it } from "vitest";

import {
  getPriwaReviewMapCenter,
  getPriwaReviewTargetPixel,
} from "./priwaReviewMapFocus";

const queue = { left: 16, right: 352, top: 96, bottom: 780 };

describe("PRIWA review map focus", () => {
  it.each([
    [1200, 456],
    [1280, 536],
    [1440, 696],
  ])(
    "keeps a focused tree in the visible map gap at %ipx",
    (viewportWidth, treePanelLeft) => {
      const map = { left: 0, right: viewportWidth, top: 0, bottom: 800 };
      const treePanel = {
        left: treePanelLeft,
        right: treePanelLeft + 352,
        top: 96,
        bottom: 780,
      };
      const target = getPriwaReviewTargetPixel(map, queue, treePanel);

      expect(target.x).toBeGreaterThan(queue.right);
      expect(target.x).toBeLessThan(treePanel.left);

      const center = getPriwaReviewMapCenter(
        [1000, 2000],
        [viewportWidth, 800],
        target,
        0.25,
      );
      const focusedPixelX = viewportWidth / 2 + (1000 - center[0]) / 0.25;
      expect(focusedPixelX).toBeCloseTo(target.x);
    },
  );
});
