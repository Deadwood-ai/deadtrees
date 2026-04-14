import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Spin, Result, Button } from "antd";
import { CorrectionEditorView } from "../components/Corrections";
import { useDatasetById } from "../hooks/useDatasets";
import { useAuth } from "../hooks/useAuthProvider";

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

  // Check authentication
  if (authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin size="large" tip="Loading..." />
      </div>
    );
  }

  if (!user) {
    return (
      <Result
        status="403"
        title="Login Required"
        subTitle="You need to be logged in to improve predictions."
        extra={
          <Button type="primary" onClick={() => navigate("/sign-in")}>
            Sign In
          </Button>
        }
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin size="large" tip="Loading dataset..." />
      </div>
    );
  }

  if (error || !dataset) {
    return (
      <Result
        status="404"
        title="Dataset Not Found"
        subTitle="The dataset you're looking for doesn't exist."
        extra={
          <Button type="primary" onClick={() => navigate("/dataset")}>
            Back to Datasets
          </Button>
        }
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
