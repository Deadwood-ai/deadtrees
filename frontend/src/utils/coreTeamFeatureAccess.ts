import type { AuthStatus } from "../hooks/useAuthProvider";

interface CoreTeamFeatureAccessState {
  authStatus: AuthStatus;
  canAudit: boolean;
  privilegesLoading: boolean;
}

/**
 * Application-side visibility/request guard for core-team interfaces. This is
 * not a backend authorization boundary; database policies remain authoritative.
 * Every unresolved, anonymous, error, or non-member state fails closed.
 */
export const canUseCoreTeamAppFeature = ({
  authStatus,
  canAudit,
  privilegesLoading,
}: CoreTeamFeatureAccessState): boolean =>
  authStatus === "authenticated" && !privilegesLoading && canAudit;
