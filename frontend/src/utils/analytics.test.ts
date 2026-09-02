import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  set_config: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  clear_opt_in_out_capturing: vi.fn(),
  has_opted_in_capturing: vi.fn(() => false),
  has_opted_out_capturing: vi.fn(() => false),
}));

vi.mock("posthog-js", () => ({
  default: posthogMock,
}));

let createAnalyticsPayload: typeof import("./analytics").createAnalyticsPayload;
let deriveUserSegment: typeof import("./analytics").deriveUserSegment;
let initializePostHog: typeof import("./analytics").initializePostHog;
let resolvePostHogApiHost: typeof import("./analytics").resolvePostHogApiHost;
let sanitizeAnalyticsUrl: typeof import("./analytics").sanitizeAnalyticsUrl;
let sanitizeEventProperties: typeof import("./analytics").sanitizeEventProperties;
let sanitizePostHogCapture: typeof import("./analytics").sanitizePostHogCapture;
let trackPageView: typeof import("./analytics").trackPageView;
let documentListeners: Map<string, EventListener[]>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_PROJECT_KEY", "ph_test_key");
  vi.stubEnv("VITE_POSTHOG_API_HOST", "https://canopy.deadtrees.earth");
  const storage = (() => {
    const values = new Map<string, string>();
    return {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
  })();
  vi.stubGlobal("localStorage", storage);
  documentListeners = new Map();
  vi.stubGlobal(
    "Element",
    class {
      classList = { contains: () => false };
    },
  );
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: EventListener) => {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
  });
  vi.stubGlobal("window", {
    location: {
      href: "https://deadtrees.earth/",
      origin: "https://deadtrees.earth",
      pathname: "/",
      search: "",
    },
    localStorage: storage,
  });
  storage.clear();
  Object.values(posthogMock).forEach((value) => {
    if ("mockReset" in value) {
      value.mockReset();
    }
  });
  posthogMock.has_opted_in_capturing.mockReturnValue(false);
  posthogMock.has_opted_out_capturing.mockReturnValue(false);

  const analytics = await import("./analytics");
  createAnalyticsPayload = analytics.createAnalyticsPayload;
  deriveUserSegment = analytics.deriveUserSegment;
  initializePostHog = analytics.initializePostHog;
  resolvePostHogApiHost = analytics.resolvePostHogApiHost;
  sanitizeAnalyticsUrl = analytics.sanitizeAnalyticsUrl;
  sanitizeEventProperties = analytics.sanitizeEventProperties;
  sanitizePostHogCapture = analytics.sanitizePostHogCapture;
  trackPageView = analytics.trackPageView;
});

describe("deriveUserSegment", () => {
  it("classifies anonymous users as visitors", () => {
    expect(deriveUserSegment(false, false)).toBe("visitor");
  });

  it("classifies signed-in contributors", () => {
    expect(deriveUserSegment(true, false)).toBe("contributor");
  });

  it("classifies core team members", () => {
    expect(deriveUserSegment(true, true)).toBe("core_team");
  });
});

describe("sanitizeEventProperties", () => {
  it("keeps only the allowlisted analytics keys", () => {
    expect(
      sanitizeEventProperties({
        dataset_id: 42,
        page: "/dataset/42",
        download_type: "dataset",
        ignored_key: "drop-me",
      }),
    ).toEqual({
      dataset_id: 42,
      page: "/dataset/42",
      download_type: "dataset",
    });
  });

  it("drops empty values from the essential payload", () => {
    expect(
      sanitizeEventProperties({
        dataset_id: 42,
        failure_reason: "",
        status: undefined,
      }),
    ).toEqual({
      dataset_id: 42,
    });
  });
});

describe("sanitizeAnalyticsUrl", () => {
  it("strips Supabase recovery tokens from URL fragments", () => {
    expect(
      sanitizeAnalyticsUrl(
        "https://deadtrees.earth/reset-password#access_token=secret&refresh_token=also-secret&type=recovery",
      ),
    ).toBe("https://deadtrees.earth/reset-password");
  });

  it("redacts sensitive query parameter values but keeps route context", () => {
    expect(
      sanitizeAnalyticsUrl(
        "/reset-password?access_token=secret&utm_source=email",
      ),
    ).toBe("/reset-password?access_token=%5Bredacted%5D&utm_source=email");
  });
});

describe("sanitizePostHogCapture", () => {
  it("sanitizes PostHog SDK URL properties before send", () => {
    expect(
      sanitizePostHogCapture({
        event: "$pageview",
        properties: {
          $current_url:
            "https://deadtrees.earth/reset-password#access_token=secret",
          $session_entry_url:
            "https://deadtrees.earth/reset-password?refresh_token=secret",
          url: "/reset-password#refresh_token=secret",
        },
      }),
    ).toEqual({
      event: "$pageview",
      properties: {
        $current_url: "https://deadtrees.earth/reset-password",
        $session_entry_url:
          "https://deadtrees.earth/reset-password?refresh_token=%5Bredacted%5D",
        url: "/reset-password",
      },
    });
  });
});

describe("createAnalyticsPayload", () => {
  it("fills shared context fields without overriding explicit properties", () => {
    const payload = createAnalyticsPayload(
      "dataset_download_started",
      {
        dataset_id: 42,
        download_type: "dataset",
      },
      {
        page: "/dataset/42",
        sourceSurface: "dataset_detail",
        isMobile: false,
        isLoggedIn: true,
        userSegment: "contributor",
      },
    );

    expect(payload).toEqual({
      dataset_id: 42,
      download_type: "dataset",
      page: "/dataset/42",
      source_surface: "dataset_detail",
      is_mobile: false,
      is_logged_in: true,
      user_segment: "contributor",
    });
  });

  it("preserves explicit event properties over the shared context", () => {
    const payload = createAnalyticsPayload(
      "dataset_opened",
      {
        dataset_id: 7,
        page: "/custom",
        source_surface: "profile",
      },
      {
        page: "/dataset/7",
        sourceSurface: "dataset_detail",
        isLoggedIn: true,
        userSegment: "contributor",
      },
    );

    expect(payload.page).toBe("/custom");
    expect(payload.source_surface).toBe("profile");
    expect(payload.is_logged_in).toBe(true);
    expect(payload.user_segment).toBe("contributor");
  });
});

describe("initializePostHog", () => {
  it("uses the managed proxy and EU UI host", () => {
    initializePostHog("accepted");

    expect(posthogMock.init).toHaveBeenCalledWith(
      "ph_test_key",
      expect.objectContaining({
        api_host: "https://canopy.deadtrees.earth",
        ui_host: "https://eu.posthog.com",
      }),
    );
  });

  it("records only bounded OpenLayers canvas frames", () => {
    initializePostHog("accepted");

    expect(posthogMock.init).toHaveBeenCalledWith(
      "ph_test_key",
      expect.objectContaining({
        session_recording: {
          captureCanvas: {
            recordCanvas: true,
            canvasFps: 1,
            canvasQuality: "0.3",
          },
          canvasCapture: {
            resolutionScale: 0.5,
            maskRegionsFn: expect.any(Function),
          },
        },
      }),
    );

    const config = posthogMock.init.mock.calls[0]?.[1];
    const scannerCanvas = {
      closest: () => null,
    } as unknown as HTMLCanvasElement;

    expect(
      config?.session_recording.canvasCapture.maskRegionsFn(scannerCanvas),
    ).toBeNull();
  });

  it("captures settled and periodic OpenLayers frames without polling", () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    initializePostHog("accepted");

    const viewport = new Element();
    viewport.classList.contains = (className: string) =>
      className === "ol-viewport";
    const canvas = {
      closest: () => viewport,
    } as unknown as HTMLCanvasElement;
    const maskRegionsFn =
      posthogMock.init.mock.calls[0]?.[1].session_recording.canvasCapture
        .maskRegionsFn;
    const emit = (type: string, event: Partial<PointerEvent>) => {
      documentListeners
        .get(type)
        ?.forEach((listener) =>
          listener({ composedPath: () => [viewport], ...event } as Event),
        );
    };

    expect(maskRegionsFn(canvas)).toEqual([]);
    expect(maskRegionsFn(canvas)).toBeNull();

    now += 5_000;
    expect(maskRegionsFn(canvas)).toEqual([]);
    expect(maskRegionsFn(canvas)).toBeNull();

    now += 30_000;
    expect(maskRegionsFn(canvas)).toEqual([]);
    expect(maskRegionsFn(canvas)).toBeNull();

    emit("pointerdown", { pointerId: 7 });
    expect(maskRegionsFn(canvas)).toBeNull();

    emit("pointerup", { pointerId: 7 });
    now += 999;
    expect(maskRegionsFn(canvas)).toBeNull();

    now += 2;
    expect(maskRegionsFn(canvas)).toEqual([]);
    expect(maskRegionsFn(canvas)).toBeNull();
  });

  it("falls back to direct EU ingestion when the proxy host is unset", async () => {
    vi.stubEnv("VITE_POSTHOG_API_HOST", "");
    vi.resetModules();
    const analytics = await import("./analytics");

    analytics.initializePostHog("pending");

    expect(posthogMock.init).toHaveBeenCalledWith(
      "ph_test_key",
      expect.objectContaining({
        api_host: "https://eu.i.posthog.com",
        ui_host: "https://eu.posthog.com",
      }),
    );
  });

  it("initializes PostHog even when an old opt-in cookie exists", () => {
    localStorage.setItem("cookieConsent", "accepted");
    localStorage.setItem("cookieConsentVersion", "1.0");
    posthogMock.has_opted_in_capturing.mockReturnValue(true);

    initializePostHog();

    expect(posthogMock.init).toHaveBeenCalledWith(
      "ph_test_key",
      expect.objectContaining({
        persistence: "memory",
        autocapture: false,
        capture_exceptions: false,
        disable_session_recording: true,
        capture_pageview: false,
      }),
    );
    expect(posthogMock.clear_opt_in_out_capturing).toHaveBeenCalledTimes(1);
  });

  it("initializes PostHog only once per page load", () => {
    initializePostHog("accepted");
    initializePostHog("accepted");

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(posthogMock.set_config).not.toHaveBeenCalled();
  });

  it("updates PostHog config when consent changes from limited to accepted", () => {
    initializePostHog("pending");
    initializePostHog("accepted");

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(posthogMock.init).toHaveBeenNthCalledWith(
      1,
      "ph_test_key",
      expect.objectContaining({
        persistence: "memory",
        autocapture: false,
        capture_exceptions: false,
        disable_session_recording: true,
        capture_pageview: false,
        capture_pageleave: false,
      }),
    );
    expect(posthogMock.set_config).toHaveBeenCalledTimes(1);
    expect(posthogMock.set_config).toHaveBeenCalledWith(
      expect.objectContaining({
        persistence: "cookie",
        autocapture: true,
        capture_exceptions: true,
        disable_session_recording: false,
        capture_pageview: false,
        capture_pageleave: false,
      }),
    );
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("clears stale opt status while consent is pending", () => {
    posthogMock.has_opted_out_capturing.mockReturnValue(true);

    initializePostHog("pending");

    expect(posthogMock.clear_opt_in_out_capturing).toHaveBeenCalledTimes(1);
  });

  it("keeps rejected consent in limited mode and opts out of capture", () => {
    initializePostHog("rejected");

    expect(posthogMock.init).toHaveBeenCalledWith(
      "ph_test_key",
      expect.objectContaining({
        persistence: "memory",
        autocapture: false,
        capture_exceptions: false,
        disable_session_recording: true,
      }),
    );
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled();
  });
});

describe("resolvePostHogApiHost", () => {
  it("normalizes a secure proxy origin", () => {
    expect(resolvePostHogApiHost(" https://canopy.deadtrees.earth/ ")).toBe(
      "https://canopy.deadtrees.earth",
    );
  });

  it.each([
    undefined,
    "",
    "http://canopy.deadtrees.earth",
    "https://canopy.deadtrees.earth/path",
    "not-a-url",
  ])("uses the direct EU fallback for %s", (configuredHost) => {
    expect(resolvePostHogApiHost(configuredHost)).toBe(
      "https://eu.i.posthog.com",
    );
  });
});

describe("trackPageView", () => {
  it("captures accepted pageviews with sanitized URL properties", () => {
    posthogMock.has_opted_in_capturing.mockReturnValue(true);

    trackPageView("https://deadtrees.earth/reset-password#access_token=secret");

    expect(posthogMock.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "https://deadtrees.earth/reset-password",
      url: "https://deadtrees.earth/reset-password",
      url_path: "/reset-password",
    });
  });

  it("captures limited pageviews without URL fragments", () => {
    trackPageView("/reset-password#refresh_token=secret");

    expect(posthogMock.capture).toHaveBeenCalledWith("$pageview", {
      url_path: "/reset-password",
    });
  });
});
