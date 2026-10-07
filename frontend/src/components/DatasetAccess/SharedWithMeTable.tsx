import { Table, Tag } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import type { ISharedDataset } from "../../api/datasetAccess";
import { useSharedWithMe } from "../../hooks/useDatasetAccess";
import EmptyStatePanel from "../EmptyStatePanel";
import { SectionLoadError, TableSkeleton } from "../SectionStates";
import { roleLabel, visibilityLabel } from "./accessCopy";

/** Datasets other people shared with the signed-in user. */
export default function SharedWithMeTable() {
  const { data = [], isLoading, isError, refetch } = useSharedWithMe();

  if (isError && data.length === 0) {
    return <SectionLoadError title="Datasets shared with you couldn’t load" onRetry={() => void refetch()} />;
  }
  if (isLoading) return <TableSkeleton rows={3} label="Loading datasets shared with you" />;

  if (data.length === 0) {
    return (
      <EmptyStatePanel
        testId="shared-with-me-empty"
        icon={<TeamOutlined />}
        title="Nothing shared with you yet"
        description="When someone shares a dataset with your account, it appears here with the access they gave you."
      />
    );
  }

  return (
    <Table<ISharedDataset>
      data-testid="shared-with-me-table"
      dataSource={data}
      rowKey="dataset_id"
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      columns={[
        {
          title: "Dataset",
          key: "dataset",
          render: (_, row) => <Link to={`/dataset/${row.dataset_id}`}>{row.file_name || `Dataset ${row.dataset_id}`}</Link>,
        },
        { title: "Visibility", key: "visibility", render: (_, row) => visibilityLabel(row.data_access) },
        { title: "Your access", key: "role", render: (_, row) => <Tag style={{ margin: 0 }}>{roleLabel(row.role)}</Tag> },
        {
          title: "Until",
          key: "expires_at",
          render: (_, row) => (row.expires_at ? new Date(row.expires_at).toLocaleDateString("en-US") : "No end date"),
        },
      ]}
    />
  );
}
