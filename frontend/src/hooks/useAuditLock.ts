import { useCallback, useEffect, useState } from "react";

import { Settings } from "../config";
import { supabase } from "./useSupabase";

/**
 * Holds the server-side audit lease for the dataset shown on an audit page.
 *
 * A live lease belongs to exactly one open page. It expires on the server (10
 * minutes) unless that page renews it, so leaving, closing or crashing the page
 * frees the dataset without client cleanup; release on unmount and page exit
 * only makes that immediate. Audit writes carry the page's lease id, and the
 * database rejects writes from any other page while the lease is live.
 */
export const AUDIT_LEASE_RENEW_MS = 2 * 60 * 1000;
const AUDIT_LEASE_HEADER = "x-audit-lease";

export type AuditLockState =
  | { status: "claiming" }
  | { status: "held"; leaseId: string }
  | { status: "denied"; heldByYou: boolean; holderEmail: string | null; retryAfterMinutes: number }
  | { status: "lost"; heldByYou: boolean; holderEmail: string | null }
  | { status: "error"; message: string };

interface ClaimResult {
  acquired: boolean;
  held_by_you?: boolean;
  holder_email?: string | null;
  retry_after_seconds?: number | null;
}

async function claimLease(datasetId: number, leaseId: string, takeOver: boolean): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc("claim_dataset_audit_lock", {
    p_dataset_id: datasetId,
    p_lease_id: leaseId,
    p_take_over: takeOver,
  });
  if (error) throw error;
  return data as ClaimResult;
}

function releaseLease(datasetId: number, leaseId: string) {
  void supabase
    .rpc("release_dataset_audit_lock", { p_dataset_id: datasetId, p_lease_id: leaseId })
    .then(({ error }) => {
      if (error) console.debug("Audit lease release failed; it will expire on the server", error);
    });
}

// Unload cancels ordinary requests; a keepalive fetch survives the page.
function releaseLeaseOnPageExit(datasetId: number, leaseId: string, accessToken: string) {
  void fetch(`${Settings.SUPABASE_URL}/rest/v1/rpc/release_dataset_audit_lock`, {
    method: "POST",
    keepalive: true,
    headers: {
      apikey: Settings.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_dataset_id: datasetId, p_lease_id: leaseId }),
  }).catch(() => undefined);
}

/** Marks an audit write as coming from the page that holds the lease. */
export function withAuditLease<Query extends { setHeader(name: string, value: string): Query }>(
  query: Query,
  leaseId: string,
): Query {
  return query.setHeader(AUDIT_LEASE_HEADER, leaseId);
}

// The database rejects audit writes while another page holds the dataset's lease.
export function isAuditLeaseConflict(error: unknown) {
  return (error as { code?: string } | null)?.code === "55006";
}

export function describeAuditLockDenial(state: Extract<AuditLockState, { status: "denied" }>) {
  if (state.heldByYou) {
    return "You have this dataset open in another tab or window.";
  }
  const holder = state.holderEmail ?? "another auditor";
  return `This dataset is being audited by ${holder}. It becomes available within ${state.retryAfterMinutes} minute${
    state.retryAfterMinutes === 1 ? "" : "s"
  } after they leave.`;
}

export function useAuditLock(datasetId: number) {
  const [state, setState] = useState<AuditLockState>({ status: "claiming" });
  // Set when the auditor chooses to continue here instead of their other page.
  const [takeOverDatasetId, setTakeOverDatasetId] = useState<number | null>(null);
  const takeOver = takeOverDatasetId === datasetId;

  useEffect(() => {
    const leaseId = crypto.randomUUID();
    let current = true;
    let held = false;
    let claimTakesOver = takeOver;
    let accessToken: string | null = null;
    setState({ status: "claiming" });

    const stopRenewing = () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", renewWhenVisible);
      window.removeEventListener("pageshow", renewAfterRestore);
    };

    const renew = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data.session?.access_token ?? null;
        const result = await claimLease(datasetId, leaseId, claimTakesOver);
        claimTakesOver = false;
        if (!current) {
          // The page left while this claim was in flight; do not strand the lease.
          if (result.acquired) releaseLease(datasetId, leaseId);
          return;
        }
        if (result.acquired) {
          held = true;
          setState((previous) => (previous.status === "held" ? previous : { status: "held", leaseId }));
          return;
        }
        stopRenewing();
        const heldByYou = result.held_by_you ?? false;
        const holderEmail = result.holder_email ?? null;
        setState(
          held
            ? { status: "lost", heldByYou, holderEmail }
            : {
                status: "denied",
                heldByYou,
                holderEmail,
                retryAfterMinutes: Math.max(1, Math.ceil((result.retry_after_seconds ?? 0) / 60)),
              },
        );
        held = false;
      } catch (error) {
        if (!current) return;
        // A failed renewal keeps the lease until it expires; the next renewal retries.
        if (held) {
          console.debug("Audit lease renewal failed", error);
          return;
        }
        stopRenewing();
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not lock dataset for audit",
        });
      }
    };

    const renewWhenVisible = () => {
      if (document.visibilityState === "visible") void renew();
    };
    // A page restored from the back/forward cache released its lease on pagehide.
    const renewAfterRestore = (event: PageTransitionEvent) => {
      if (event.persisted) void renew();
    };
    const releaseOnPageExit = () => {
      if (held && accessToken) releaseLeaseOnPageExit(datasetId, leaseId, accessToken);
    };

    const timer = window.setInterval(() => void renew(), AUDIT_LEASE_RENEW_MS);
    document.addEventListener("visibilitychange", renewWhenVisible);
    window.addEventListener("pageshow", renewAfterRestore);
    window.addEventListener("pagehide", releaseOnPageExit);
    void renew();

    return () => {
      current = false;
      stopRenewing();
      window.removeEventListener("pagehide", releaseOnPageExit);
      releaseLease(datasetId, leaseId);
    };
  }, [datasetId, takeOver]);

  const continueHere = useCallback(() => setTakeOverDatasetId(datasetId), [datasetId]);

  return { state, continueHere };
}
