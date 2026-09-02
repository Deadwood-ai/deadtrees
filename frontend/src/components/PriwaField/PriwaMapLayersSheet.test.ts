import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaMapLayersSheet from "./PriwaMapLayersSheet";

describe("PriwaMapLayersSheet", () => {
  it("combines base maps and Warnkarte in one compact mobile sheet", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaMapLayersSheet, {
        open: true,
        baseLayer: "aerial",
        warnkarteAvailable: true,
        warnkarteLoading: false,
        warnkarteVisible: true,
        legendVisible: true,
        onClose: () => undefined,
        onBaseLayerChange: () => undefined,
        onWarnkarteVisibilityChange: () => undefined,
        onLegendVisibilityChange: () => undefined,
        onZoomToWarnkarte: () => undefined,
      }),
    );

    expect(html).toContain('data-mobile-bottom-sheet-snap="compact"');
    expect(html).toContain("Luftbild");
    expect(html).toContain("Topografische Karte");
    expect(html).toContain("Warnkarte");
    expect(html).toContain('aria-label="Zur Warnkarte zoomen"');
    expect(html).toContain('aria-label="Warnkarten-Legende anzeigen"');
    expect(html).toContain('aria-label="Kartenebenen schließen"');
  });

  it("keeps the Warnkarte toggle available when data must be loaded", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaMapLayersSheet, {
        open: true,
        baseLayer: "topographic",
        warnkarteAvailable: false,
        warnkarteLoading: false,
        warnkarteVisible: true,
        legendVisible: true,
        onClose: () => undefined,
        onBaseLayerChange: () => undefined,
        onWarnkarteVisibilityChange: () => undefined,
        onLegendVisibilityChange: () => undefined,
        onZoomToWarnkarte: () => undefined,
      }),
    );

    expect(html).toContain("Beim Aktivieren laden");
    expect(html).not.toContain('aria-label="Zur Warnkarte zoomen"');
  });
});
