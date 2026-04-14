import { Tag } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { ReferenceDatasetStatus } from "../../hooks/useReferencePatches";

interface Props {
  status: ReferenceDatasetStatus;
  size?: "small" | "default";
}

export default function ReferenceBadge({ status, size = "default" }: Props) {
  if (status === null) return null;

  if (status === "ready") {
    return (
      <Tag icon={<CheckCircleOutlined />} color="success" style={{ fontSize: size === "small" ? "12px" : "14px" }}>
        Reference Ready
      </Tag>
    );
  }

  return (
    <Tag icon={<ClockCircleOutlined />} color="processing" style={{ fontSize: size === "small" ? "12px" : "14px" }}>
      Reference Pending
    </Tag>
  );
}
