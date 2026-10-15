import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../hooks/useAuthProvider";

/** The backend checks the named allowlist and establishes protected asset access. */
export default function BenchmarkAccess({
  children,
}: {
  children: React.ReactNode;
}) {
  const { session, loading } = useAuth();
  const access = useQuery({
    queryKey: ["disturbance-benchmark-access", session?.user.id],
    enabled: !loading && Boolean(session),
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/v1/disturbance-benchmark/access", {
        signal,
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${session!.access_token}` },
      });
      if (!response.ok) throw new Error("Access could not be confirmed.");
      const result = await response.json();
      return result.allowed === true;
    },
  });
  if (loading || (session && access.isPending))
    return <p role="status">Checking benchmark access…</p>;
  if (!session || access.isError || !access.data) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-32">
        <h1>Internal forest disturbance benchmark</h1>
        <p>
          Access is limited to invited users. Sign in with an authorized
          account.
        </p>
        {session && (
          <button onClick={() => void access.refetch()}>
            Check access again
          </button>
        )}
      </main>
    );
  }
  return children;
}
