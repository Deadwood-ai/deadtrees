import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaFlightDownload from "./PriwaFlightDownload";
import PriwaFlightBar from "./PriwaFlightBar";
import PriwaFlightPanel from "./PriwaFlightPanel";
import PriwaOfflineFlightSection from "./PriwaOfflineFlightSection";
import type { IPriwaFlightListItem } from "./priwaFieldFlights";
import type { IPriwaOfflineMosaic } from "./priwaOfflineMosaics";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import type { PriwaOfflineMosaicsState } from "./usePriwaOfflineMosaics";

const mosaic = (id: string, label: string): IPriwaMosaic => ({
  id,
  projectId: "project-1",
  label,
  cogUrl: `/cogs/${id}.tif`,
  bbox: "BOX(8.1 48.4,8.2 48.5)",
  captureDate: "2026-08-12",
  createdAt: "2026-08-14T00:00:00.000Z",
  authors: ["PRIWA"],
  additionalInformation: null,
  flightType: null,
});

const item = (
  mosaicValue: IPriwaMosaic,
  overrides: Partial<IPriwaFlightListItem> = {},
): IPriwaFlightListItem => ({
  mosaic: mosaicValue,
  matchedTreeCount: 0,
  isVisible: false,
  isPrimary: false,
  offlineEntry: null,
  isAvailable: true,
  ...overrides,
});

const entry = (mosaicValue: IPriwaMosaic): IPriwaOfflineMosaic => ({
  mosaic: mosaicValue,
  bytes: 312 * 1024 * 1024,
  areaKm2: 1.8,
  etag: null,
  lastModified: null,
  fileName: "a.tif",
  savedAt: "2026-09-10T00:00:00.000Z",
  available: true,
});

const offlineState = (
  overrides: Partial<PriwaOfflineMosaicsState> = {},
): PriwaOfflineMosaicsState => ({
  mosaics: [],
  entries: [],
  plans: [],
  progress: null,
  error: null,
  libraryError: null,
  busy: false,
  isLoading: false,
  persistent: null,
  supported: true,
  plan: async () => undefined,
  download: async () => undefined,
  remove: async () => undefined,
  cancel: () => undefined,
  clearPlan: () => undefined,
  ...overrides,
});

const noop = () => undefined;
const panelProps = {
  isLoading: false,
  isOnline: true,
  offline: offlineState(),
  onClose: noop,
  onShow: noop,
  onSelect: noop,
  selectedItem: null,
  mapCenter: null,
  onHide: noop,
  onFit: noop,
};

describe("PriwaFlightBar", () => {
  it("names the shown flight and offers fit-to-flight", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightBar, {
        primary: mosaic("a", "Hangflug Nord"),
        isVisible: true,
        isAvailable: true,
        onToggleVisibility: noop,
        flightCount: 4,
        isLoading: false,
        isOpen: false,
        hasOfflineCopy: true,
        onOpen: noop,
        onFit: noop,
      }),
    );

    expect(html).toContain("Hangflug Nord");
    expect(html).toContain(
      "Aufnahme 12.08.2026 · Sichtbar · offline gespeichert",
    );
    expect(html).toContain('aria-label="Auf Befliegung zoomen"');
  });

  it("invites choosing a flight when none is shown", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightBar, {
        primary: null,
        isVisible: false,
        isAvailable: false,
        onToggleVisibility: noop,
        flightCount: 3,
        isLoading: false,
        isOpen: false,
        hasOfflineCopy: false,
        onOpen: noop,
        onFit: noop,
      }),
    );

    expect(html).toContain("Befliegung wählen");
    expect(html).toContain("3 verfügbar");
    expect(html).not.toContain('aria-label="Auf Befliegung zoomen"');
  });
});

describe("PriwaFlightPanel", () => {
  const primary = mosaic("a", "Hangflug Nord");
  const compare = mosaic("b", "Hangflug Süd");
  const other = mosaic("c", "Talflug");
  const items = [
    item(primary, { isVisible: true, isPrimary: true, matchedTreeCount: 5 }),
    item(compare),
    item(other, { isAvailable: false }),
  ];

  it("renders a bottom sheet with selection, independent visibility and zoom", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightPanel, {
        ...panelProps,
        open: true,
        placement: "sheet",
        items,
        selectedItem: items[0],
      }),
    );

    expect(html).toContain('data-mobile-bottom-sheet-snap="expanded"');
    expect(html).toContain("Ausgewählte Befliegung");
    // The selected flight is pinned above the scrolling list.
    expect(html.indexOf('data-testid="priwa-flight-details"')).toBeLessThan(
      html.indexOf("data-map-panel-scroll-viewport"),
    );
    expect(html).toContain('aria-label="Befliegung offline laden"');
    expect(html).toContain("5 im Umfeld");
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-label="Hangflug Nord auswählen"');
    expect(html).not.toContain("Vergleich");
    expect(html).toContain('aria-label="Auf Hangflug Süd zoomen"');
    expect(html).toContain("Alle Befliegungen (3)");
    expect(html).toContain('aria-label="Talflug auswählen"');
    expect(html).toContain('aria-label="Talflug einblenden"');
    expect(html).toContain("nur online");
    expect(html).not.toContain("min-[992px]:hidden");
  });

  it("renders a side panel in landscape and an offline notice without network", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightPanel, {
        ...panelProps,
        open: true,
        placement: "side",
        isOnline: false,
        items,
        selectedItem: items[0],
      }),
    );

    expect(html).toContain("data-priwa-flight-panel");
    expect(html).toContain('aria-label="Befliegungen schließen"');
    expect(html).toContain("nur offline gespeicherte Befliegungen");
  });

  it("renders nothing while closed", () => {
    expect(
      renderToStaticMarkup(
        createElement(PriwaFlightPanel, {
          ...panelProps,
          open: false,
          placement: "sheet",
          items,
          selectedItem: items[0],
        }),
      ),
    ).toBe("");
  });
});

describe("PriwaOfflineFlightSection", () => {
  const flight = mosaic("a", "Hangflug Nord");

  it("explains the full-footprint download and offers to prepare the shown flight", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightDownload, {
        offline: offlineState(),
        flight,
        isOnline: true,
      }),
    );

    expect(html).toContain("Befliegung offline laden");
  });

  it("shows the planned size before an explicit download", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightDownload, {
        offline: offlineState({
          plans: [
            {
              mosaic: flight,
              bytes: 312 * 1024 * 1024,
              areaKm2: 1.8,
              etag: null,
              lastModified: null,
            },
          ],
        }),
        flight,
        isOnline: true,
      }),
    );

    expect(html).toContain("312 MiB · 1,8 km² · volle Auflösung");
    expect(html).toContain("Jetzt herunterladen");
    expect(html).toContain("Verwerfen");
  });

  it("shows progress with cancellation while downloading", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightDownload, {
        offline: offlineState({
          busy: true,
          plans: [
            {
              mosaic: flight,
              bytes: 400 * 1024 * 1024,
              areaKm2: 0.2,
              etag: null,
              lastModified: null,
            },
          ],
          progress: {
            label: "Hangflug Nord",
            downloadedBytes: 100 * 1024 * 1024,
            totalBytes: 400 * 1024 * 1024,
          },
        }),
        flight,
        isOnline: true,
      }),
    );

    expect(html).toContain("Hangflug Nord wird gespeichert");
    expect(html).toContain("100 MiB von 400 MiB");
    expect(html).toContain('aria-label="Download abbrechen"');
  });

  it("only notes another flight's running download", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightDownload, {
        offline: offlineState({
          busy: true,
          plans: [
            {
              mosaic: flight,
              bytes: 400 * 1024 * 1024,
              areaKm2: 0.2,
              etag: null,
              lastModified: null,
            },
          ],
          progress: {
            label: "Hangflug Nord",
            downloadedBytes: 100 * 1024 * 1024,
            totalBytes: 400 * 1024 * 1024,
          },
        }),
        flight: mosaic("b", "Hangflug Süd"),
        isOnline: true,
      }),
    );

    expect(html).toContain("Eine andere Befliegung wird gespeichert.");
    expect(html).not.toContain("wird gespeichert</span>");
    expect(html).not.toContain('aria-label="Download abbrechen"');
  });

  it("lists saved flights with zoom, removal and the eviction notice", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaOfflineFlightSection, {
        offline: offlineState({ entries: [entry(flight)], persistent: false }),
        onZoomToFlight: noop,
      }),
    );

    expect(html).toContain("Gespeichert 10.09.2026 · 312 MiB · 1,8 km²");
    expect(html).toContain(
      'aria-label="Zur gespeicherten Befliegung Hangflug Nord zoomen"',
    );
    expect(html).toContain(
      'aria-label="Offline-Befliegung Hangflug Nord entfernen"',
    );
    expect(html).toContain("1 von 2 gespeichert · 312 MiB von 500 MiB");
    expect(html).toContain("bei Speichermangel");
  });

  it("surfaces failures with a retry", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightDownload, {
        offline: offlineState({
          error: "Offline-Download fehlgeschlagen.",
          plans: [
            {
              mosaic: flight,
              bytes: 1024 * 1024,
              areaKm2: 0.2,
              etag: null,
              lastModified: null,
            },
          ],
        }),
        flight,
        isOnline: true,
      }),
    );

    expect(html).toContain("Offline-Download fehlgeschlagen.");
    expect(html).toContain("Erneut versuchen");
  });
  it("does not attach another flight's prepared download to the selection", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaFlightDownload, {
        offline: offlineState({
          plans: [
            {
              mosaic: flight,
              bytes: 1024,
              areaKm2: 0.2,
              etag: null,
              lastModified: null,
            },
          ],
        }),
        flight: mosaic("b", "Hangflug Süd"),
        isOnline: true,
      }),
    );
    expect(html).not.toContain("Jetzt herunterladen");
    expect(html).toContain("Befliegung offline laden");
  });
});
