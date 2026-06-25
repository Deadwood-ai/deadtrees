import type { UserPrivileges } from "../hooks/useUserPrivileges";

/**
 * Open-vocabulary ("AI") dataset search is a core-team-only feature: it is
 * gated to the same users who can audit datasets. The `/search/embed` endpoint
 * stays public + rate-limited, so this only controls whether the UI is offered.
 */
export function canUseAiSearch(
  privileges: UserPrivileges | null | undefined,
): boolean {
  return privileges?.can_audit === true;
}
