import { describe, expect, it, vi } from "vitest";

vi.mock("./useSupabase", () => ({
  supabase: {},
}));

describe("processing email preference", () => {
  it("defaults to enabled until the user stores a preference", async () => {
    const { resolveProcessingEmailPreference } =
      await import("./useProcessingEmailPreference");

    expect(resolveProcessingEmailPreference(null)).toBe(true);
  });

  it("respects an explicit opt-out", async () => {
    const { resolveProcessingEmailPreference } =
      await import("./useProcessingEmailPreference");

    expect(
      resolveProcessingEmailPreference({
        user_id: "user-1",
        processing_emails_enabled: false,
      }),
    ).toBe(false);
  });
});
