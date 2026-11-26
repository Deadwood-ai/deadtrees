import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../hooks/useSupabase";
import { useAuth } from "../../hooks/useAuthProvider";
import { InlineLoadError, InlineSkeleton } from "../SectionStates";
import type { EvaluationDecision } from "../../types/auditChecks";

/** get_dataset_status_details: the dataset's audit decision, for its owner only. */
interface OwnerReview {
  dataset_id: number;
  audit_decision: EvaluationDecision;
  audit_decided_at: string | null;
}

const DECISION_TEXT: Record<OwnerReview["audit_decision"], string> = {
  keep: "Ready to use.",
  exclude: "Excluded from the public maps and downloads.",
};

export default function ReviewFindings({ datasetId }: { datasetId: number }) {
  const { user } = useAuth();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["owner-review-details", user?.id, datasetId],
    enabled: !!user,
    queryFn: async () => {
      const result = await supabase.rpc("get_dataset_status_details", {
        p_dataset_id: datasetId,
      });
      if (result.error) throw result.error;
      return result.data as OwnerReview | null;
    },
    staleTime: 15_000,
  });
  if (isPending)
    return (
      <InlineSkeleton label="Loading review details" className="h-4 w-48" />
    );
  if (isError)
    return (
      <InlineLoadError
        message="Review details couldn’t load."
        onRetry={() => void refetch()}
      />
    );
  if (!data)
    return (
      <p className="text-slate-500">
        The audit has not decided on this dataset yet.
      </p>
    );
  return (
    <dl className="space-y-3">
      <div>
        <dt className="text-xs font-medium text-slate-500">Audit decision</dt>
        <dd className="m-0 text-sm text-slate-800">
          {DECISION_TEXT[data.audit_decision]}
          {data.audit_decided_at && (
            <span className="ml-1 text-slate-500">
              ({new Date(data.audit_decided_at).toLocaleDateString()})
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}
