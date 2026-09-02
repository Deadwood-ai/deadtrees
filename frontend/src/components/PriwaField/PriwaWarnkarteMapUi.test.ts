import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { IPriwaWarnkarteOverlay } from "../../api/priwaWarnkarte";
import PriwaWarnkarteMapUi from "./PriwaWarnkarteMapUi";

const overlay: IPriwaWarnkarteOverlay = {
  type: "FeatureCollection",
  version_id: "warnkarte-1",
  source_date: "2024-06-25",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [8.1, 48.4],
            [8.2, 48.4],
            [8.2, 48.5],
            [8.1, 48.4],
          ],
        ],
      },
      properties: { probability: 0.6 },
    },
  ],
};

const renderUi = (isMobile: boolean, isVisible: boolean) =>
  renderToStaticMarkup(
    createElement(PriwaWarnkarteMapUi, {
      isMobile,
      isLayersOpen: true,
      baseLayer: "aerial",
      overlay,
      isLoading: false,
      isVisible,
      onCloseLayers: () => undefined,
      onBaseLayerChange: () => undefined,
      onVisibilityChange: () => undefined,
      onZoom: () => undefined,
    }),
  );

describe("PriwaWarnkarteMapUi", () => {
  it("owns the mobile layers sheet and dismissible legend", () => {
    const html = renderUi(true, true);

    expect(html).toContain('aria-label="Kartenebenen"');
    expect(html).toContain('aria-label="Warnkarten-Legende"');
    expect(html).toContain('aria-label="Warnkarten-Legende schließen"');
  });

  it("keeps the active desktop legend visible without a mobile-only close action", () => {
    const html = renderUi(false, true);

    expect(html).not.toContain('aria-label="Kartenebenen"');
    expect(html).toContain('aria-label="Warnkarten-Legende"');
    expect(html).not.toContain('aria-label="Warnkarten-Legende schließen"');
  });

  it("does not render a legend while the Warnkarte is off", () => {
    const html = renderUi(true, false);

    expect(html).not.toContain('aria-label="Warnkarten-Legende"');
  });
});
