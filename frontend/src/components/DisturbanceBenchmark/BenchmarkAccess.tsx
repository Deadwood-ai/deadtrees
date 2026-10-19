import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { Navigate } from "react-router-dom";
import { fetchBenchmarkFiles } from "../../api/disturbanceBenchmark";
import { useAuth } from "../../hooks/useAuthProvider";
import { useCanAudit } from "../../hooks/useUserPrivileges";
import StatusPage, { StatusPageLoading } from "../StatusPage";

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
const BenchmarkFilesContext = createContext<string | null>(null);

/** Absolute URL of a benchmark export file, e.g. `catalog.json` or `/data/<site>/site.json`. */
export function useBenchmarkAsset(): (path: string) => string {
  const filesBase = useContext(BenchmarkFilesContext);
  if (!filesBase)
    throw new Error("useBenchmarkAsset is used outside BenchmarkAccess");
  return (path) => `${filesBase}/${path.replace(/^\/(data\/)?/, "")}`;
}

function RetryPage({ onRetry }: { onRetry: () => void }) {
  return (
    <StatusPage
      kind="offline"
      title="The benchmark couldn’t load"
      description="DeadTrees didn’t respond while checking your access. Check your connection and try again in a moment."
      actions={
        <Button type="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

/**
 * Core-team gate for the internal benchmark, inside RequireAuth. Everyone else is
 * sent to the public releases, so the page stays unlisted. The API checks the
 * same privilege again for every file; this only decides what the visitor sees.
 */
export default function BenchmarkAccess({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const privileges = useCanAudit();
  const grant = useQuery({
    queryKey: ["disturbance-benchmark-files", user?.id],
    queryFn: fetchBenchmarkFiles,
    enabled: privileges.canAudit,
    retry: false,
    staleTime: Infinity,
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      return expiresAt
        ? Math.max(
            60_000,
            expiresAt * 1000 - Date.now() - REFRESH_BEFORE_EXPIRY_MS,
          )
        : false;
    },
  });

  if (privileges.isLoading || (privileges.canAudit && grant.isPending))
    return <StatusPageLoading label="Checking access…" />;
  if (privileges.isError)
    return <RetryPage onRetry={() => void privileges.refetch()} />;
  if (!privileges.canAudit) return <Navigate to="/releases" replace />;
  // A failed refresh keeps the previous link, which stays valid for a few minutes.
  if (!grant.data) return <RetryPage onRetry={() => void grant.refetch()} />;
  return (
    <BenchmarkFilesContext.Provider value={grant.data.filesUrl}>
      {children}
    </BenchmarkFilesContext.Provider>
  );
}
