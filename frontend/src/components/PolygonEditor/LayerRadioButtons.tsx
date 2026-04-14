import { Radio, Space, Card } from "antd";

export type LayerSelection = "deadwood" | "forest_cover" | "ortho_only";

interface Props {
  value: LayerSelection;
  onChange: (value: LayerSelection) => void;
  position?: "bottom-left" | "bottom-right";
  availableLayers?: LayerSelection[]; // Optional: filter which layers to show
  showAOIIndicator?: boolean; // Whether to show "AOI: Always Visible" text
}

export default function LayerRadioButtons({
  value,
  onChange,
  position = "bottom-left",
  availableLayers,
  showAOIIndicator = true,
}: Props) {
  // If no filter provided, show all layers
  const showDeadwood = !availableLayers || availableLayers.includes("deadwood");
  const showForestCover = !availableLayers || availableLayers.includes("forest_cover");
  const showOrthoOnly = !availableLayers || availableLayers.includes("ortho_only");

  return (
    <div className={`absolute ${position === "bottom-left" ? "left-2" : "right-2"} bottom-2 z-10`}>
      <Card size="small" className="shadow-lg" bodyStyle={{ padding: "12px", width: 180 }}>
        <Radio.Group value={value} onChange={(e) => onChange(e.target.value)}>
          <Space direction="vertical" size="small" className="w-full">
            {showOrthoOnly && (
              <Radio value="ortho_only">
                <span className="flex items-center justify-between">
                  Ortho Only
                  <span className="ml-2 text-xs text-gray-400">(1)</span>
                </span>
              </Radio>
            )}
            {showDeadwood && (
              <Radio value="deadwood">
                <span className="flex items-center justify-between">
                  Deadwood
                  <span className="ml-2 text-xs text-gray-400">(2)</span>
                </span>
              </Radio>
            )}
            {showForestCover && (
              <Radio value="forest_cover">
                <span className="flex items-center justify-between">
                  Forest Cover
                  <span className="ml-2 text-xs text-gray-400">(3)</span>
                </span>
              </Radio>
            )}
          </Space>
        </Radio.Group>

        {/* AOI always visible indicator */}
        {showAOIIndicator && (
          <div className="mt-2 border-t pt-2 text-xs text-gray-500">AOI: Always Visible</div>
        )}
      </Card>
    </div>
  );
}
