import { lazy, Suspense } from "react";
import { Button } from "antd";
import { Link, useParams } from "react-router-dom";

import { usePublicDatasetById } from "../hooks/useDatasets";
import { useAuth } from "../hooks/useAuthProvider";
import StatusPage, { StatusPageLoading } from "../components/StatusPage";

const DatasetDetailsView = lazy(() => import("./DatasetDetailsView"));

const archiveButton = (
  <Link to="/dataset">
    <Button>Browse the drone archive</Button>
  </Link>
);

// Start the existing auth-scoped query while the map screen downloads, and own
// every state that is not a loaded dataset.
export default function DatasetDetails() {
  const { id } = useParams();
  const { status } = useAuth();
  const datasetId = id && /^\d+$/.test(id) ? Number(id) : undefined;
  const { data, isLoading, isError, refetch } = usePublicDatasetById(datasetId);
  const loading = <StatusPageLoading label="Loading dataset…" />;

  if (datasetId === undefined) {
    return (
      <StatusPage
        kind="not-found"
        title="Dataset not found"
        description="This link has no valid dataset ID. Check the address or find the dataset in the archive."
        actions={archiveButton}
      />
    );
  }

  if (status === "checking" || isLoading) return loading;

  // A failed background refetch keeps showing the dataset that already loaded.
  if (data) {
    return (
      <Suspense fallback={loading}>
        <DatasetDetailsView dataset={data} />
      </Suspense>
    );
  }

  if (isError) {
    return (
      <StatusPage
        kind="offline"
        title="This dataset couldn’t load"
        description="DeadTrees didn’t respond. Check your connection and try again in a moment."
        actions={
          <>
            <Button type="primary" onClick={() => void refetch()}>
              Try again
            </Button>
            {archiveButton}
          </>
        }
      />
    );
  }

  return status === "authenticated" ? (
    <StatusPage
      kind="not-found"
      title="Dataset not found"
      description={`Dataset ${datasetId} doesn’t exist, or it is private and not shared with your account. Ask the owner to share it with you.`}
      actions={archiveButton}
    />
  ) : (
    <StatusPage
      kind="locked"
      title="This dataset isn’t available"
      description={`Dataset ${datasetId} doesn’t exist, or it is private. If it was shared with you, sign in to open it.`}
      actions={
        <>
          <Link
            to={`/sign-in?returnTo=${encodeURIComponent(`/dataset/${datasetId}`)}`}
          >
            <Button type="primary">Sign in</Button>
          </Link>
          {archiveButton}
        </>
      }
    />
  );
}
