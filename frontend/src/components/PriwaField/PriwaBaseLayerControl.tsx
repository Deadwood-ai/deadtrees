import { GlobalOutlined, PictureOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";

import type { PriwaBaseLayer } from "./types";

interface PriwaBaseLayerControlProps {
  value: PriwaBaseLayer;
  onChange: (value: PriwaBaseLayer) => void;
}

export default function PriwaBaseLayerControl({
  value,
  onChange,
}: PriwaBaseLayerControlProps) {
  const isAerial = value === "aerial";
  const actionLabel = isAerial
    ? "Zu Karte wechseln"
    : "Zu Luftbild wechseln";

  return (
    <Tooltip title={actionLabel} placement="right">
      <Button
        className="pointer-events-auto shadow-md"
        shape="circle"
        size="large"
        icon={isAerial ? <PictureOutlined /> : <GlobalOutlined />}
        aria-label={actionLabel}
        data-active-layer={value}
        onClick={() => onChange(isAerial ? "topographic" : "aerial")}
      />
    </Tooltip>
  );
}
