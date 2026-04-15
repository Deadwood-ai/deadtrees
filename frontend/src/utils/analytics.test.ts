import { describe, expect, it } from "vitest";

import {
  createAnalyticsPayload,
  deriveUserSegment,
  sanitizeEventProperties,
} from "./analytics";

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
