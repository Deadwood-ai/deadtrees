import { describe, expect, it } from "vitest";

import { getPriwaOfflineStatusView } from "./priwaOfflineStatusView";

describe("PRIWA offline status labels", () => {
  it("shows ready when the app shell service worker is ready", () => {
    expect(getPriwaOfflineStatusView("ready", true)).toEqual({
      label: "Offline bereit",
      color: "success",
    });
  });

  it("shows limited offline state when the browser is offline before readiness", () => {
    expect(getPriwaOfflineStatusView("registering", false)).toEqual({
      label: "Offline eingeschränkt",
      color: "warning",
    });
  });

  it("distinguishes registration and unsupported states while online", () => {
    expect(getPriwaOfflineStatusView("registering", true)).toEqual({
      label: "Offline wird vorbereitet",
      color: "processing",
    });
    expect(getPriwaOfflineStatusView("unsupported", true)).toEqual({
      label: "Offline nicht unterstützt",
      color: "warning",
    });
  });
});
