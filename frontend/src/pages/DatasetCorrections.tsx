import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "antd";
import { CorrectionEditorView } from "../components/Corrections";
import { useDatasetById } from "../hooks/useDatasets";
import { useAuth } from "../hooks/useAuthProvider";
import StatusPage, { StatusPageLoading } from "../components/StatusPage";

/**
 * Page wrapper for the CorrectionEditorView
 * Route: /dataset/:id/corrections
 */
export default function DatasetCorrections() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const datasetId = id ? parseInt(id, 10) : undefined;
  const initialLayer = (searchParams.get("layer") as "deadwood" | "forest_cover") || "deadwood";

  const { data: dataset, isLoading, error } = useDatasetById(datasetId);

  const handleClose = () => {
    if (datasetId) {
      navigate(`/dataset/${datasetId}`);
    } else {
      navigate("/dataset");
    }
  };

  if (authLoading) return <StatusPageLoading label="Loading…" />;

  if (!user) {
    const returnTo = `/dataset-corrections/${id ?? ""}${searchParams.toString() ? `?${searchParams}` : ""}`;
    return (
      <StatusPage
        kind="locked"
        title="Sign in to improve predictions"
        description="Corrections are saved to your account, so you need to be signed in to edit."
        actions={
          <Button type="primary" onClick={() => navigate(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`)}>
            Sign in
          </Button>
        }
      />
    );
  }

  if (isLoading) return <StatusPageLoading label="Loading dataset…" />;

  // A failed background refetch must not unmount the editor and its drafts.
  if (error && !dataset) {
    return (
      <StatusPage
        kind="offline"
        title="This dataset couldn’t load"
        description="DeadTrees didn’t respond. Check your connection and try again in a moment."
        actions={<Button type="primary" onClick={() => window.location.reload()}>Reload page</Button>}
      />
    );
  }

  if (!dataset) {
    return (
      <StatusPage
        kind="not-found"
        title="Dataset not found"
        description="It doesn’t exist, or it is private and not shared with your account."
        actions={<Button onClick={() => navigate("/dataset")}>Browse the drone archive</Button>}
      />
    );
  }

  return (
    <CorrectionEditorView
      dataset={dataset}
      initialLayerType={initialLayer}
      onClose={handleClose}
    />
  );
}
