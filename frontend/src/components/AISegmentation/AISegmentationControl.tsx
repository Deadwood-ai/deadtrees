import { Button, Space, Tooltip } from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import React from "react";

interface Props {
  active: boolean;
  processing: boolean;
  canUse: boolean;
  onToggle: () => void;
  onClear: () => void;
  error?: string | null;
}

const AISegmentationControl: React.FC<Props> = ({ active, processing, canUse, onToggle, onClear, error }) => {
  return (
    <Space.Compact className="rounded-md bg-white">
      <Tooltip title={!canUse ? "Ortho layer unavailable" : active ? "Disable box tool" : "Enable box tool"}>
        <Button type={active ? "primary" : "default"} onClick={onToggle} disabled={!canUse || processing}>
          {processing ? <LoadingOutlined /> : null}
          Segment (Box)
        </Button>
      </Tooltip>
      <Tooltip title="Clear AI results">
        <Button onClick={onClear} disabled={processing}>
          Clear
        </Button>
      </Tooltip>
      {error ? (
        <span className="ml-2 text-sm text-red-500" role="alert">
          {error}
        </span>
      ) : null}
    </Space.Compact>
  );
};

export default AISegmentationControl;
