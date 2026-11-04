import { useState } from "react";
import { Button, Dropdown, Modal, Table, Tag, type MenuProps } from "antd";
import type { ColumnType } from "antd/es/table";
import { DownOutlined, EditOutlined, ShareAltOutlined, TeamOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import type { ISharedDataset } from "../../api/datasetAccess";
import { useSharedWithMe } from "../../hooks/useDatasetAccess";
import { usePublicDatasetById } from "../../hooks/useDatasets";
import { HIGHLIGHTED_ROW_CLASS, useHighlightedRow } from "../Account/useHighlightedRow";
import EditDatasetModal from "../EditDatasetModal";
import EmptyStatePanel from "../EmptyStatePanel";
import { SectionLoadError, SectionSkeleton, TableSkeleton } from "../SectionStates";
import ShareDatasetModal from "./ShareDatasetModal";
import { roleLabel, visibilityLabel } from "./accessCopy";

const PAGE_SIZE = 20;

/** The shared list has no metadata, so the edit form loads the dataset when it opens. */
function EditSharedDatasetModal({ datasetId, onClose }: { datasetId: number; onClose: () => void }) {
  const { data: dataset, isPending, refetch } = usePublicDatasetById(datasetId);
  if (dataset) return <EditDatasetModal visible onClose={onClose} dataset={dataset} />;
  return (
    <Modal open title="Edit details" footer={null} onCancel={onClose}>
      {isPending ? (
        <SectionSkeleton rows={4} label="Loading dataset details" />
      ) : (
        <SectionLoadError title="This dataset’s details couldn’t load" onRetry={() => void refetch()} />
      )}
    </Modal>
  );
}

/** Datasets other people shared with the signed-in user. */
export default function SharedWithMeTable() {
  const { data = [], isLoading, isError, refetch } = useSharedWithMe();
  const highlight = useHighlightedRow(data.map((row) => row.dataset_id), PAGE_SIZE);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sharing, setSharing] = useState<ISharedDataset | null>(null);

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

  const actionsFor = (row: ISharedDataset): MenuProps["items"] => [
    { key: "edit", label: "Edit details", icon: <EditOutlined />, onClick: () => setEditingId(row.dataset_id) },
    ...(row.role === "admin"
      ? [{ key: "share", label: "Share", icon: <ShareAltOutlined />, onClick: () => setSharing(row) }]
      : []),
  ];

  const actionsColumn: ColumnType<ISharedDataset> = {
    title: "Actions",
    key: "actions",
    fixed: "right",
    render: (_, row) =>
      row.role !== "reader" && (
        <Dropdown menu={{ items: actionsFor(row) }} trigger={["click"]} placement="bottomRight">
          <Button size="small">
            Actions <DownOutlined />
          </Button>
        </Dropdown>
      ),
  };

  return (
    <>
      <Table<ISharedDataset>
        data-testid="shared-with-me-table"
        dataSource={data}
        rowKey="dataset_id"
        scroll={{ x: "max-content" }}
        pagination={{ pageSize: PAGE_SIZE, hideOnSinglePage: true, current: highlight.page, onChange: highlight.setPage }}
        onRow={(row) => ({ "aria-current": row.dataset_id === highlight.highlightId || undefined })}
        rowClassName={(row) => (row.dataset_id === highlight.highlightId ? HIGHLIGHTED_ROW_CLASS : "")}
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
          ...(data.some((row) => row.role !== "reader") ? [actionsColumn] : []),
        ]}
      />
      {editingId !== null && <EditSharedDatasetModal datasetId={editingId} onClose={() => setEditingId(null)} />}
      <ShareDatasetModal datasetId={sharing?.dataset_id ?? null} datasetName={sharing?.file_name} onClose={() => setSharing(null)} />
    </>
  );
}
