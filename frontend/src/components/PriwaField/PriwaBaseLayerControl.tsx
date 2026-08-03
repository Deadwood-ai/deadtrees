import { GlobalOutlined } from "@ant-design/icons";
import { Button, Popover, Segmented } from "antd";

import type { PriwaBaseLayer } from "./types";

interface PriwaBaseLayerControlProps {
  value: PriwaBaseLayer;
  onChange: (value: PriwaBaseLayer) => void;
}

export default function PriwaBaseLayerControl({
  value,
  onChange,
}: PriwaBaseLayerControlProps) {
  return (
    <Popover
      trigger="click"
      placement="rightTop"
      content={
        <div className="w-56">
          <div className="mb-2 text-sm font-medium text-slate-900">
            Kartenbasis
          </div>
          <Segmented<PriwaBaseLayer>
            block
            value={value}
            options={[
              { label: "Luftbild", value: "aerial" },
              { label: "Karte", value: "topographic" },
            ]}
            onChange={onChange}
          />
        </div>
      }
    >
      <Button
        className="pointer-events-auto shadow-md"
        shape="circle"
        size="large"
        icon={<GlobalOutlined />}
        aria-label="Layer auswählen"
      />
    </Popover>
  );
}
