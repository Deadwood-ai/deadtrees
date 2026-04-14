import { ArrowLeftOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Button, Space, Tooltip, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { IDataset } from "../../types/dataset";
import { useDatasetDetailsMap } from "../../hooks/useDatasetDetailsMapProvider";

interface DatasetNavigationProps {
  currentDatasetId: number;
  overlappingDatasets: IDataset[];
  isLoading: boolean;
}

export default function DatasetNavigation({
  currentDatasetId,
  overlappingDatasets,
  isLoading,
}: DatasetNavigationProps) {
  const navigate = useNavigate();
  const { setNavigationSource } = useDatasetDetailsMap();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-2">
        <Typography.Text className="text-gray-500">Loading related datasets...</Typography.Text>
      </div>
    );
  }

  if (!overlappingDatasets || overlappingDatasets.length === 0) {
    return null;
  }

  // Find the index of the current dataset in the sorted list
  const currentIndex = overlappingDatasets.findIndex((dataset) => dataset.id === currentDatasetId);

  // Determine previous and next datasets
  const prevDataset = currentIndex > 0 ? overlappingDatasets[currentIndex - 1] : null;
  const nextDataset = currentIndex < overlappingDatasets.length - 1 ? overlappingDatasets[currentIndex + 1] : null;

  const formatDate = (dataset: IDataset) => {
    return new Date(
      dataset.aquisition_year,
      dataset.aquisition_month ? dataset.aquisition_month - 1 : 0,
      dataset.aquisition_day || 1,
    ).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="mt-4 space-y-3 rounded-md bg-white p-4">
      <Typography.Title level={5} style={{ margin: 0 }}>
        Related Datasets ({overlappingDatasets.length})
      </Typography.Title>
      <Typography.Text className="text-sm text-gray-500">
        Datasets from the same geographical area at different times
      </Typography.Text>
      <Space direction="horizontal" className="mt-2 flex w-full justify-between">
        <Tooltip title={prevDataset ? `View dataset from ${formatDate(prevDataset)}` : "No earlier dataset available"}>
          <Button
            icon={<ArrowLeftOutlined />}
            disabled={!prevDataset}
            onClick={() => {
              if (prevDataset) {
                // Set navigation source to 'navigation' to preserve viewport
                setNavigationSource("navigation");
                navigate(`/dataset/${prevDataset.id}`);
              }
            }}
          >
            {prevDataset ? formatDate(prevDataset) : "Previous"}
          </Button>
        </Tooltip>
        <Tooltip title={nextDataset ? `View dataset from ${formatDate(nextDataset)}` : "No later dataset available"}>
          <Button
            icon={<ArrowRightOutlined />}
            disabled={!nextDataset}
            onClick={() => {
              if (nextDataset) {
                // Set navigation source to 'navigation' to preserve viewport
                setNavigationSource("navigation");
                navigate(`/dataset/${nextDataset.id}`);
              }
            }}
          >
            {nextDataset ? formatDate(nextDataset) : "Next"}
          </Button>
        </Tooltip>
      </Space>
    </div>
  );
}
