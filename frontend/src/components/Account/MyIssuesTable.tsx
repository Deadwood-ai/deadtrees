import { Button, Table, Tag, Tooltip, Typography } from "antd";
import { FlagOutlined } from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
import { useMyFlags } from "../../hooks/useDatasetFlags";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { DatasetFlag } from "../../types/flags";
import EmptyStatePanel from "../EmptyStatePanel";

/** Issues the signed-in user reported on datasets. */
export default function MyIssuesTable() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { data: flags = [], isLoading } = useMyFlags();

  if (!isLoading && flags.length === 0) {
    return (
      <EmptyStatePanel
        testId="my-issues-empty"
        icon={<FlagOutlined />}
        title="Help us fix flawed results"
        description="Spotted a problem in an orthomosaic or a prediction? Report it from the dataset's page. Your reports and their status appear here."
      />
    );
  }

  return (
    <>
      <div className="mb-6">
        <Typography.Title level={4} style={{ margin: 0 }}>My Issues</Typography.Title>
        <Typography.Text type="secondary">
          User-reported issues you've filed. Only you and auditors can view them.
        </Typography.Text>
      </div>
      <div className="overflow-hidden rounded-xl border border-gray-100">
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={flags}
          columns={[
          {
            title: "Dataset ID",
            dataIndex: "dataset_id",
            key: "dataset_id",
            responsive: ["xs"],
            render: (id: number) => (
              <Link to={`/dataset/${id}`} className="font-medium text-[#1B5E35] hover:underline">
                {id}
              </Link>
            ),
          },
          {
            title: "Description",
            key: "description",
            responsive: ["sm"],
            render: (_: unknown, f: DatasetFlag) => (
              <Tooltip title={f.description}>
                <span className="text-gray-600">{(f.description || "").slice(0, 120) + (f.description.length > 120 ? "…" : "")}</span>
              </Tooltip>
            ),
          },
          {
            title: "Categories",
            key: "categories",
            responsive: ["md"],
            render: (_: unknown, f: DatasetFlag) => (
              <div className="flex gap-1">
                {f.is_ortho_mosaic_issue && <Tag color="orange" className="m-0 border-none bg-orange-50 font-medium">Orthomosaic</Tag>}
                {f.is_prediction_issue && <Tag color="blue" className="m-0 border-none bg-blue-50 font-medium">Segmentation</Tag>}
              </div>
            ),
          },
          {
            title: "Status",
            dataIndex: "status",
            key: "status",
            responsive: ["xs"],
            render: (status: string) => (
              <Tag 
                className="m-0 border-none font-medium capitalize"
                color={status === "open" ? "red" : status === "acknowledged" ? "gold" : "green"}
              >
                {status}
              </Tag>
            ),
          },
          {
            title: "Created",
            dataIndex: "created_at",
            key: "created_at",
            responsive: ["sm"],
            render: (iso: string) => <span className="text-gray-500">{new Date(iso).toLocaleString()}</span>,
          },
          // Removed last status change per requirements
          {
            title: "Actions",
            key: "actions",
            responsive: ["xs"],
            render: (_: unknown, f: DatasetFlag) => (
              <Button size="small" onClick={() => navigate(`/dataset/${f.dataset_id}`)}>
                View Map
              </Button>
            ),
          },
          ]}
          pagination={{ pageSize: 10 }}
          scroll={{ x: isMobile ? 560 : "max-content" }}
        />
      </div>
    </>
  );
}
