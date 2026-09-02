import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaOfflineMapPanel from "./PriwaOfflineMapPanel";

const cacheState = {
  isCaching: false,
  cached: 0,
  failed: 0,
  total: 0,
  errorMessage: null,
};

describe("PriwaOfflineMapPanel", () => {
  it("anchors management at the bottom and explains viewport coverage", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineMapPanel, {
        areas: [],
        cacheState,
        coverageRatio: 0.82,
        isSupported: true,
        needsRefresh: false,
        readyAreaCount: 0,
        isMobile: false,
        onClose: () => undefined,
        onStartSelection: () => undefined,
        onClear: async () => undefined,
        onRefresh: async () => undefined,
      }),
    );

    expect(html).toContain('data-priwa-offline-map-panel="true"');
    expect(html).toContain("bottom-4");
    expect(html).toContain("82 % der aktuellen Kartenansicht");
    expect(html).toContain("Neuen Bereich auswählen");
  });

  it("offers a one-time refresh for legacy iPhone caches", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineMapPanel, {
        areas: [
          {
            id: "area-1",
            projectId: "project-1",
            name: "Offline-Bereich",
            extent3857: [0, 0, 100, 100],
            centerLonLat: [8, 48],
            zoom: 18,
            minZoom: 16,
            maxZoom: 20,
            tileCount: 100,
            cachedTileCount: 100,
            failedTileCount: 0,
            areaKm2: 1,
            status: "ready",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        cacheState,
        coverageRatio: 0,
        isSupported: true,
        needsRefresh: true,
        readyAreaCount: 0,
        isMobile: false,
        onClose: () => undefined,
        onStartSelection: () => undefined,
        onClear: async () => undefined,
        onRefresh: async () => undefined,
      }),
    );

    expect(html).toContain("auf dem iPhone ohne Netz funktionieren");
    expect(html).toContain("Offline-Karten aktualisieren");
  });

  it("uses a compact dismissible sheet on mobile", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineMapPanel, {
        areas: [],
        cacheState,
        coverageRatio: 0.5,
        isSupported: true,
        needsRefresh: false,
        readyAreaCount: 0,
        isMobile: true,
        onClose: () => undefined,
        onStartSelection: () => undefined,
        onClear: async () => undefined,
        onRefresh: async () => undefined,
      }),
    );

    expect(html).toContain('data-mobile-bottom-sheet-snap="compact"');
    expect(html).toContain('aria-label="Offline-Karten schließen"');
    expect(html).toContain("50 % der aktuellen Kartenansicht");
  });
});
