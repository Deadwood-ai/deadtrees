import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaOfflineAreaSelection from "./PriwaOfflineAreaSelection";

describe("PriwaOfflineAreaSelection", () => {
  it("shows the clear selection frame and package size before download", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineAreaSelection, {
        plan: {
          extent3857: [909_000, 6_179_000, 911_132, 6_181_132],
          areaKm2: 1.98,
          minZoom: 16,
          maxZoom: 20,
          selectionZoom: 16,
          tileCount: 5_559,
          urls: [],
        },
        cacheState: {
          isCaching: false,
          cached: 0,
          failed: 0,
          total: 0,
          errorMessage: null,
        },
        isMobile: false,
        onCancel: () => undefined,
        onDismiss: () => undefined,
        onConfirm: async () => undefined,
      }),
    );

    expect(html).toContain('data-priwa-offline-selection-frame="true"');
    expect(html).toContain("aspect-ratio:1");
    expect(html).toContain("min(84cqw, 58cqh)");
    expect(html).toContain("198 ha");
    expect(html).toContain("5.559 Kacheln");
    expect(html).toContain("Karte verschieben oder zoomen");
    expect(html).toContain("Bereich herunterladen");
  });

  it("keeps mobile selection actions in a compact dismissible sheet", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineAreaSelection, {
        plan: null,
        cacheState: {
          isCaching: false,
          cached: 0,
          failed: 0,
          total: 0,
          errorMessage: null,
        },
        isMobile: true,
        onCancel: () => undefined,
        onDismiss: () => undefined,
        onConfirm: async () => undefined,
      }),
    );

    expect(html).toContain("Offline-Bereich auswählen");
    expect(html).toContain('data-mobile-bottom-sheet-snap="compact"');
    expect(html).toContain('aria-label="Bereichsauswahl schließen"');
    expect(html).toContain('data-priwa-offline-selection-panel="true"');
  });
});
