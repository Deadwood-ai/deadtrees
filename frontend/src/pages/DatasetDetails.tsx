import { lazy, Suspense } from "react";
import { Spin } from "antd";
import { useParams } from "react-router-dom";

import { usePublicDatasetById } from "../hooks/useDatasets";

const DatasetDetailsView = lazy(() => import("./DatasetDetailsView"));

// Start the existing auth-scoped query while the map screen downloads.
export default function DatasetDetails() {
  const { id } = useParams();
  const datasetId = id ? Number(id) : undefined;
  const hasValidDatasetId =
    typeof datasetId === "number" && Number.isFinite(datasetId);
  const { data, isLoading } = usePublicDatasetById(
    hasValidDatasetId ? datasetId : undefined,
  );

  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-60 w-full items-center justify-center">
          <Spin size="large" />
        </div>
      }
    >
      <DatasetDetailsView
        dataset={data}
        isLoading={!hasValidDatasetId || isLoading}
      />
    </Suspense>
  );
}
