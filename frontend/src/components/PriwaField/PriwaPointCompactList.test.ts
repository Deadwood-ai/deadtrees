import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PriwaPointCompactList from "./PriwaPointCompactList";
import type { IPriwaPoint } from "./types";

const point = (overrides: Partial<IPriwaPoint> = {}): IPriwaPoint =>
  ({
    id: "p1",
    baumnr: "BAM64",
    fund: "ja",
    baumart: "Fichte",
    name: "andere",
    datum: "2026-09-10",
    lat: 48.47714,
    lon: 9.04757,
    coordinateSource: "gps",
    gps: "ja",
    ...overrides,
  }) as IPriwaPoint;

describe("PriwaPointCompactList", () => {
  it("renders one compact row per tree with status, source and actions", () => {
    const html = renderToStaticMarkup(
      createElement(PriwaPointCompactList, {
        points: [
          point(),
          point({
            id: "p2",
            baumnr: "4",
            coordinateSource: "qr",
            fund: "ja_kein_buchdrucker",
            syncStatus: "pending",
          }),
        ],
        groupByTreeId: {
          p2: { id: "g1", name: "Gruppe Nord" } as never,
        },
        onEditPoint: () => undefined,
        onZoomToPoint: () => undefined,
      }),
    );

    expect(html.match(/data-testid="priwa-point-row"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="BAM64 auf Karte zeigen"');
    expect(html).toContain('aria-label="QA prüfen"');
    expect(html).toContain("GPS");
    expect(html).toContain("Ja · Fichte · andere · 10.09.2026");
    expect(html).toContain('aria-label="Exakt"');
    expect(html).toContain("Ja, kein Buchdrucker");
    expect(html).toContain("Lokal");
    expect(html).toContain("Gruppe Nord");
    expect(html).toContain('aria-label="Punkt bearbeiten"');
  });
});
