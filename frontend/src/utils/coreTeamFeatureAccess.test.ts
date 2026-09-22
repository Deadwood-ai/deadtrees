import { describe, expect, it } from "vitest";

import { canUseCoreTeamAppFeature } from "./coreTeamFeatureAccess";

describe("core-team feature access", () => {
  it.each([
    ["checking", true, true],
    ["anonymous", true, false],
    ["authenticated", false, false],
    ["authenticated", true, true],
  ] as const)(
    "fails closed for auth=%s canAudit=%s loading=%s",
    (authStatus, canAudit, privilegesLoading) => {
      expect(
        canUseCoreTeamAppFeature({
          authStatus,
          canAudit,
          privilegesLoading,
        }),
      ).toBe(false);
    },
  );

  it("allows a resolved authenticated core-team member", () => {
    expect(
      canUseCoreTeamAppFeature({
        authStatus: "authenticated",
        canAudit: true,
        privilegesLoading: false,
      }),
    ).toBe(true);
  });
});
