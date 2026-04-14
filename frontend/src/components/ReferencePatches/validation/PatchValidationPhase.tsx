import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Flex, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { IDataset } from "../../../types/dataset";
import { IReferencePatch, PatchResolution, PatchStatus } from "../../../types/referencePatches";
import { useReferencePatches, useUpdatePatchStatus } from "../../../hooks/useReferencePatches";
import ReferencePatchMap from "../ReferencePatchMap";

interface Props {
  dataset: IDataset;
}

type StatusFilter = PatchStatus | "all";

const RESOLUTION_OPTIONS: { label: string; value: PatchResolution | "all" }[] = [
  { label: "All", value: "all" },
  { label: "20cm", value: 20 },
  { label: "10cm", value: 10 },
  { label: "5cm", value: 5 },
];

const STATUS_OPTIONS: { label: string; value: StatusFilter }[] = [
  { label: "All", value: "all" },
  { label: "Good", value: "good" },
  { label: "Bad", value: "bad" },
  { label: "Pending", value: "pending" },
];

export default function PatchValidationPhase({ dataset }: Props) {
  const { data: allPatches = [] } = useReferencePatches(dataset.id);
  const { mutate: updateStatus, isPending: updating } = useUpdatePatchStatus();

  const [selectedResolution, setSelectedResolution] = useState<PatchResolution | "all">("all");
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>("all");
  const [selectedPatch, setSelectedPatch] = useState<IReferencePatch | null>(null);
  const [showOnlyNeedsReview, setShowOnlyNeedsReview] = useState(false);

  const filteredPatches = useMemo(() => {
    return allPatches.filter((patch) => {
      if (selectedResolution !== "all" && patch.resolution_cm !== selectedResolution) return false;
      if (selectedStatus !== "all" && patch.status !== selectedStatus) return false;
      if (showOnlyNeedsReview && patch.status === "pending") return true;
      if (showOnlyNeedsReview && patch.status !== "pending") return false;
      return true;
    });
  }, [allPatches, selectedResolution, selectedStatus, showOnlyNeedsReview]);

  const stats = useMemo(() => {
    const counts: Record<PatchResolution, { good: number; bad: number; pending: number }> = {
      20: { good: 0, bad: 0, pending: 0 },
      10: { good: 0, bad: 0, pending: 0 },
      5: { good: 0, bad: 0, pending: 0 },
    };
    allPatches.forEach((patch) => {
      counts[patch.resolution_cm][patch.status] += 1;
    });
    return counts;
  }, [allPatches]);

  const columns: ColumnsType<IReferencePatch> = [
    {
      title: "Index",
      dataIndex: "patch_index",
      key: "patch_index",
      render: (value) => <Typography.Text className="font-mono">{value}</Typography.Text>,
    },
    {
      title: "Resolution",
      dataIndex: "resolution_cm",
      key: "resolution",
      render: (value: PatchResolution) => <Tag color="blue">{value}cm</Tag>,
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (value: PatchStatus) => (
        <Tag color={value === "good" ? "green" : value === "bad" ? "red" : "default"}>{value.toUpperCase()}</Tag>
      ),
    },
    {
      title: "AOI %",
      dataIndex: "aoi_coverage_percent",
      key: "aoi",
      render: (value: number | null) => (value != null ? `${value}%` : "—"),
    },
    {
      title: "Deadwood %",
      dataIndex: "deadwood_prediction_coverage_percent",
      key: "deadwood",
      render: (value: number | null) => (value != null ? `${value}%` : "—"),
    },
    {
      title: "Forest %",
      dataIndex: "forest_cover_prediction_coverage_percent",
      key: "forest",
      render: (value: number | null) => (value != null ? `${value}%` : "—"),
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => setSelectedPatch(record)}>
            Zoom
          </Button>
          <Button size="small" type="primary" onClick={() => handleStatusChange(record, "good")} loading={updating}>
            Good
          </Button>
          <Button size="small" danger onClick={() => handleStatusChange(record, "bad")} loading={updating}>
            Bad
          </Button>
        </Space>
      ),
    },
  ];

  const handleStatusChange = (patch: IReferencePatch, status: PatchStatus) => {
    updateStatus({ patchId: patch.id, status });
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ marginBottom: 0 }}>
          Phase 3: Validate & Review
        </Typography.Title>
        <Space>
          <Select
            value={selectedResolution}
            style={{ width: 140 }}
            onChange={(value) => setSelectedResolution(value as PatchResolution | "all")}
            options={RESOLUTION_OPTIONS}
          />
          <Select
            value={selectedStatus}
            style={{ width: 140 }}
            onChange={(value) => setSelectedStatus(value as StatusFilter)}
            options={STATUS_OPTIONS}
          />
          <Checkbox checked={showOnlyNeedsReview} onChange={(e) => setShowOnlyNeedsReview(e.target.checked)}>
            Pending only
          </Checkbox>
        </Space>
      </Flex>

      <Flex gap={16} wrap>
        <Statistic
          title="20cm Good"
          value={stats[20].good}
          suffix={`/ ${stats[20].good + stats[20].bad + stats[20].pending || 0}`}
        />
        <Statistic
          title="10cm Good"
          value={stats[10].good}
          suffix={`/ ${stats[10].good + stats[10].bad + stats[10].pending || 0}`}
        />
        <Statistic
          title="5cm Good"
          value={stats[5].good}
          suffix={`/ ${stats[5].good + stats[5].bad + stats[5].pending || 0}`}
        />
      </Flex>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="relative flex-1">
          <ReferencePatchMap
            datasetId={dataset.id}
            cogPath={dataset.cog_path}
            patches={filteredPatches}
            onPatchSelected={setSelectedPatch}
            focusPatchId={selectedPatch?.id}
            layerSelection="deadwood"
            selectedPatchId={selectedPatch?.id}
            selectedBasePatch={selectedPatch}
          />
          {/* Note: LayerRadioButtons not shown in validation view, using default "deadwood" */}
        </div>
        <div className="w-1/2 flex-shrink-0">
          <Table
            size="small"
            dataSource={filteredPatches}
            columns={columns}
            rowKey="id"
            pagination={{ pageSize: 10 }}
            onRow={(record) => ({
              onClick: () => setSelectedPatch(record),
            })}
          />
        </div>
      </div>

      <Card size="small" title={selectedPatch ? `Selected: ${selectedPatch.patch_index}` : "No patch selected"}>
        {selectedPatch ? (
          <Space>
            <Button type="primary" onClick={() => handleStatusChange(selectedPatch, "good")}>
              Mark Good
            </Button>
            <Button danger onClick={() => handleStatusChange(selectedPatch, "bad")}>
              Mark Bad
            </Button>
            <Button onClick={() => handleStatusChange(selectedPatch, "pending")}>Reset Pending</Button>
          </Space>
        ) : (
          <Typography.Text type="secondary">Pick a patch from the table or map to review.</Typography.Text>
        )}
      </Card>
    </div>
  );
}
