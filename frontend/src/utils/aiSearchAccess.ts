import type { UserPrivileges } from "../hooks/useUserPrivileges";

/**
 * Open-vocabulary ("AI") search is temporarily restricted to auditors. The
 * ranking RPCs enforce the same capability; this helper controls only the UI.
 * Keeping this as a single policy seam makes a later public rollout explicit.
 */
export function canUseAiSearch(
  privileges: UserPrivileges | null | undefined,
): boolean {
  return privileges?.can_audit === true;
}
