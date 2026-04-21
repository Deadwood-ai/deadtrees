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
let sanitizeEventProperties: typeof import("./analytics").sanitizeEventProperties;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_PROJECT_KEY", "ph_test_key");
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
  sanitizeEventProperties = analytics.sanitizeEventProperties;
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
        capture_pageview: true,
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
        capture_pageview: true,
        capture_pageleave: false,
      }),
    );
    expect(posthogMock.set_config).toHaveBeenCalledTimes(1);
    expect(posthogMock.set_config).toHaveBeenCalledWith(
      expect.objectContaining({
        persistence: "cookie",
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
      }),
    );
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1);
  });

  it("clears stale opt status while consent is pending", () => {
    posthogMock.has_opted_out_capturing.mockReturnValue(true);

    initializePostHog("pending");

    expect(posthogMock.clear_opt_in_out_capturing).toHaveBeenCalledTimes(1);
  });
});
