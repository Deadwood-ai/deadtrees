import { describe, expect, it } from "vitest";

import { canUseAiSearch } from "./aiSearchAccess";
import type { UserPrivileges } from "../hooks/useUserPrivileges";

const privileges = (overrides: Partial<UserPrivileges>): UserPrivileges => ({
  id: 1,
  user_id: "user-1",
  can_upload_private: false,
  can_audit: false,
  can_view_all_private: false,
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("canUseAiSearch", () => {
  it("allows users who can audit (core team)", () => {
    expect(canUseAiSearch(privileges({ can_audit: true }))).toBe(true);
  });

  it("denies privileged users that lack the audit flag", () => {
    expect(
      canUseAiSearch(
        privileges({ can_upload_private: true, can_view_all_private: true }),
      ),
    ).toBe(false);
  });

  it("denies users without a privileges row", () => {
    expect(canUseAiSearch(null)).toBe(false);
    expect(canUseAiSearch(undefined)).toBe(false);
  });
});
