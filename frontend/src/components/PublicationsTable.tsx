import React from "react";
import { Table, Tag, Typography, Button, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useAuth } from "../hooks/useAuthProvider";
import { ClockCircleOutlined, FileDoneOutlined } from "@ant-design/icons";
import { useIsMobile } from "../hooks/useIsMobile";
import { useMyPublications, type IMyPublication } from "../hooks/useDataPublications";
import EmptyStatePanel from "./EmptyStatePanel";
import { SectionLoadError, TableSkeleton } from "./SectionStates";

interface PublicationsTableProps {
  /** Opens the dataset list, where datasets are selected for publishing. */
  onChooseDatasets: () => void;
}

const PublicationsTable: React.FC<PublicationsTableProps> = ({ onChooseDatasets }) => {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const { data: publications = [], isLoading: loading, isError, refetch } = useMyPublications(user?.id);

  const columns: ColumnsType<IMyPublication> = [
    {
      title: "Title",
      dataIndex: "title",
      key: "title",
      responsive: ["xs"],
      render: (text: string) => <Typography.Text strong>{text}</Typography.Text>,
    },
    {
      title: "Created",
      dataIndex: "created_at",
      key: "created_at",
      responsive: ["sm"],
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: "Datasets",
      dataIndex: "datasets",
      key: "datasets",
      responsive: ["sm"],
      render: (count: number) => <Tag color="blue">{count}</Tag>,
    },
    {
      title: "Status",
      dataIndex: "doi",
      key: "status",
      responsive: ["xs"],
      render: (doi: string | null) => (doi ? <Tag color="green">Published</Tag> : <Tag color="orange">Pending</Tag>),
    },
    {
      title: "DOI",
      dataIndex: "doi",
      key: "doi",
      responsive: ["xs"],
      render: (doi: string | null) =>
        doi ? (
          <Tooltip title="View publication">
            <Button type="link" href={`https://doi.org/${doi}`} target="_blank">
              <img src={`https://freidata.uni-freiburg.de/badge/DOI/${doi}.svg`} alt="FreiDATA badge" />
            </Button>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">
            <Tag icon={<ClockCircleOutlined />} color="orange">
              in Review
            </Tag>
          </Typography.Text>
        ),
    },
  ];

  if (loading) return <TableSkeleton rows={3} label="Loading your publications" />;

  if (isError) {
    return <SectionLoadError title="Your publications couldn’t load" onRetry={() => void refetch()} />;
  }

  if (publications.length === 0) {
    return (
      <EmptyStatePanel
        testId="publications-empty"
        icon={<FileDoneOutlined />}
        title="Get a citable DOI for your data"
        description="Select processed datasets in My Datasets and publish them through FreiDATA. Each publication gets one DOI that others can cite."
        action={<Button onClick={onChooseDatasets}>Choose datasets to publish</Button>}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <Table
        dataSource={publications}
        columns={columns}
        rowKey="id"
        scroll={{ x: isMobile ? 560 : "max-content" }}
        pagination={{ pageSize: 10 }}
      />
    </div>
  );
};

export default PublicationsTable;
