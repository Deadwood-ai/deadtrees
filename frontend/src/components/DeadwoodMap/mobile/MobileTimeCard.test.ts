import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MobileTimeCard from "./MobileTimeCard";

const renderCard = (isBrowsingImageryHistory: boolean) =>
  renderToStaticMarkup(
    createElement(MobileTimeCard, {
      predictionYear: "2025",
      productName: "Tree and deadwood cover",
      isWaybackActive: true,
      isLoadingImagery: true,
      waybackItems: [],
      selectedReleaseNum: null,
      isUsingLiveImagery: true,
      isBrowsingImageryHistory,
      autoMatchImagery: false,
      onPredictionYearChange: () => undefined,
      onImageryChange: () => undefined,
      onUseLiveImagery: () => undefined,
      onBrowseHistory: () => undefined,
      onAutoMatchChange: () => undefined,
    }),
  );

describe("MobileTimeCard", () => {
  it("keeps the return to Latest visible while history discovery is pending", () => {
    expect(renderCard(true)).toContain("Back to latest imagery");
    expect(renderCard(false)).not.toContain("Back to latest imagery");
  });
});
