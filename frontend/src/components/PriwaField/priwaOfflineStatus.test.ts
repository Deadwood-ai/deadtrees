import { describe, expect, it } from "vitest";

import { getPriwaOfflineStatusView } from "./priwaOfflineStatusView";

const readyInput = {
  serviceWorkerStatus: "ready" as const,
  isOnline: true,
  isSupported: true,
  isCacheAuditComplete: true,
  hasAreas: true,
  needsRefresh: false,
};

describe("PRIWA offline map status", () => {
  it("only shows ready when at least 80 percent of the viewport is cached", () => {
    expect(
      getPriwaOfflineStatusView({ ...readyInput, coverageRatio: 0.8 }),
    ).toEqual({ label: "Offline bereit", color: "success" });
    expect(
      getPriwaOfflineStatusView({ ...readyInput, coverageRatio: 0.79 }),
    ).toEqual({ label: "Teilweise offline", color: "warning" });
  });

  it("distinguishes saved areas elsewhere from no downloaded maps", () => {
    expect(
      getPriwaOfflineStatusView({ ...readyInput, coverageRatio: 0 }),
    ).toEqual({ label: "Bereich nicht offline", color: "default" });
    expect(
      getPriwaOfflineStatusView({
        ...readyInput,
        hasAreas: false,
        coverageRatio: 0,
      }),
    ).toEqual({ label: "Offline-Karte laden", color: "default" });
  });

  it("surfaces legacy packages outside covered views and waits for cache audits", () => {
    expect(
      getPriwaOfflineStatusView({
        ...readyInput,
        needsRefresh: true,
        coverageRatio: 0,
      }),
    ).toEqual({ label: "Offline-Karte aktualisieren", color: "warning" });
    expect(
      getPriwaOfflineStatusView({
        ...readyInput,
        isCacheAuditComplete: false,
        coverageRatio: 1,
      }),
    ).toEqual({ label: "Offline wird geprüft", color: "processing" });
  });

  it("reports an unsupported offline runtime", () => {
    expect(
      getPriwaOfflineStatusView({
        ...readyInput,
        isSupported: false,
        coverageRatio: 0,
      }),
    ).toEqual({ label: "Offline nicht unterstützt", color: "warning" });
  });
});
