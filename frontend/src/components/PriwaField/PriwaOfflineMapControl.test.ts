import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaOfflineMapControl from "./PriwaOfflineMapControl";

describe("PriwaOfflineMapControl", () => {
  it("exposes whether downloaded-area visualization is active", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineMapControl, {
        areas: [],
        cacheState: {
          isCaching: false,
          cached: 0,
          failed: 0,
          total: 0,
          errorMessage: null,
        },
        isSupported: true,
        active: true,
        onToggle: () => undefined,
        onStartSelection: () => undefined,
        onClear: async () => undefined,
      }),
    );

    expect(html).toContain('aria-pressed="true"');
  });

  it("does not present stored areas as an active overlay", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineMapControl, {
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
        cacheState: {
          isCaching: false,
          cached: 0,
          failed: 0,
          total: 0,
          errorMessage: null,
        },
        isSupported: true,
        active: false,
        onToggle: () => undefined,
        onStartSelection: () => undefined,
        onClear: async () => undefined,
      }),
    );

    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("border-emerald-600");
    expect(html).not.toContain("ant-btn-primary");
  });
});
