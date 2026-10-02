import { Table, Tag, Typography } from "antd";
import { Link } from "react-router-dom";
import type { ISharedDataset } from "../../api/datasetAccess";
import { useSharedWithMe } from "../../hooks/useDatasetAccess";
import { roleLabel, visibilityLabel } from "./accessCopy";

/** Datasets other people shared with the signed-in user. */
export default function SharedWithMeTable() {
  const { data = [], isLoading } = useSharedWithMe();

  if (!isLoading && data.length === 0) {
    return (
      <div className="my-12 flex flex-col items-center justify-center text-center" data-testid="shared-with-me-empty">
        <Typography.Title level={4} className="mb-2">
          Nothing shared with you yet
        </Typography.Title>
        <Typography.Text type="secondary" className="text-base">
          When someone shares a dataset with your account, it appears here.
        </Typography.Text>
      </div>
    );
  }

  return (
    <Table<ISharedDataset>
      data-testid="shared-with-me-table"
      loading={isLoading}
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
