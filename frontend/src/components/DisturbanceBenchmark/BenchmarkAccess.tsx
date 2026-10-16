import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Result, Spin } from "antd";
import { Navigate } from "react-router-dom";
import { Settings } from "../../config";
import { useAuth } from "../../hooks/useAuthProvider";
import { useCanAudit } from "../../hooks/useUserPrivileges";
import { canUseCoreTeamAppFeature } from "../../utils/coreTeamFeatureAccess";

interface BenchmarkFilesGrant {
  files_url: string;
  expires_at: number;
}

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
const BenchmarkFilesContext = createContext<string | null>(null);

/** Absolute URL of a benchmark export file, e.g. `catalog.json` or `/data/<site>/site.json`. */
export function useBenchmarkAsset(): (path: string) => string {
  const filesBase = useContext(BenchmarkFilesContext);
  if (!filesBase)
    throw new Error("useBenchmarkAsset is used outside BenchmarkAccess");
  return (path) => `${filesBase}/${path.replace(/^\/(data\/)?/, "")}`;
}

/**
 * Core-team gate for the internal benchmark. The API checks the same privilege
 * again for every file, so this only decides what the visitor sees.
 */
export default function BenchmarkAccess({
  children,
}: {
  children: React.ReactNode;
}) {
  const { session, status } = useAuth();
  const { canAudit, isLoading: privilegesLoading } = useCanAudit();
  const isCoreTeam = canUseCoreTeamAppFeature({
    authStatus: status,
    canAudit,
    privilegesLoading,
  });
  const grant = useQuery<BenchmarkFilesGrant>({
    queryKey: ["disturbance-benchmark-files", session?.user.id],
    enabled: isCoreTeam,
    retry: false,
    staleTime: Infinity,
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expires_at;
      return expiresAt
        ? Math.max(60_000, expiresAt * 1000 - Date.now() - REFRESH_BEFORE_EXPIRY_MS)
        : false;
    },
    queryFn: async ({ signal }): Promise<BenchmarkFilesGrant> => {
      const response = await fetch(
        `${Settings.API_URL}/disturbance-benchmark/access`,
        {
          method: "POST",
          signal,
          headers: { Authorization: `Bearer ${session!.access_token}` },
        },
      );
      if (!response.ok) throw new Error("Access could not be confirmed.");
      return response.json();
    },
  });

  if (status === "checking" || privilegesLoading || (isCoreTeam && grant.isPending))
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spin />
      </div>
    );
  if (!isCoreTeam) return <Navigate to="/releases" replace />;
  if (grant.isError)
    return (
      <Result
        className="py-32"
        status="warning"
        title="The benchmark could not be opened"
        subTitle="The storage server did not confirm access. Try again in a moment."
        extra={<Button onClick={() => void grant.refetch()}>Try again</Button>}
      />
    );
  return (
    <BenchmarkFilesContext.Provider
      value={`${Settings.API_URL}${grant.data!.files_url}`}
    >
      {children}
    </BenchmarkFilesContext.Provider>
  );
}
