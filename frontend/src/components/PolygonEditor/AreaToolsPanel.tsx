import { Button, Input, Segmented, Space, Typography } from "antd";
import { MinusSquareOutlined, PlusSquareOutlined, SearchOutlined, SwapOutlined } from "@ant-design/icons";
import type { AreaAction } from "../../hooks/useAreaTools";

type LayerType = "deadwood" | "forest_cover";

export interface AreaToolsPanelProps {
  layer: LayerType;
  onSwitchLayer: (layer: LayerType) => void;
  action: AreaAction | null;
  preview: { count: number; total: number } | null;
  onStart: (action: AreaAction) => void;
  findPrompt: string;
  onFindPromptChange: (text: string) => void;
  onAcceptPreview: () => void;
  onDiscardPreview: () => void;
  canCopy: boolean;
  onCopyToOtherLayer: () => void;
  disabled: boolean;
}

/** Layer switch, area tools (add, remove, find) and copy between layers for the label editor. */
export default function AreaToolsPanel({
  layer,
  onSwitchLayer,
  action,
  preview,
  onStart,
  findPrompt,
  onFindPromptChange,
  onAcceptPreview,
  onDiscardPreview,
  canCopy,
  onCopyToOtherLayer,
  disabled,
}: AreaToolsPanelProps) {
  const other = layer === "deadwood" ? "tree cover" : "deadwood";
  const areaButton = (kind: AreaAction, label: string, icon: React.ReactNode, title: string) => (
    <Button
      icon={icon}
      block
      htmlType="button"
      type={action === kind ? "primary" : "default"}
      disabled={disabled}
      onClick={() => onStart(kind)}
      title={title}
    >
      {label}
    </Button>
  );

  return (
    <Space direction="vertical" size="small" className="w-full">
      <Segmented
        block
        size="small"
        value={layer}
        onChange={(value) => onSwitchLayer(value as LayerType)}
        options={[
          { label: "Dead (1)", value: "deadwood" },
          { label: "Trees (2)", value: "forest_cover" },
        ]}
      />
      {areaButton("add", "Add area (Q)", <PlusSquareOutlined />, "Drag to outline an area and merge it into this layer")}
      {areaButton("remove", "Remove area (E)", <MinusSquareOutlined />, "Drag to outline an area and cut it out of this layer")}
      <Input
        size="small"
        value={findPrompt}
        onChange={(e) => onFindPromptChange(e.target.value)}
        placeholder="What to find"
        aria-label="Text to find in area"
        maxLength={80}
      />
      {areaButton("find", "Find in area (F)", <SearchOutlined />, "Drag to outline an area; AI finds what the text describes")}
      {preview && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2">
          <Typography.Text className="text-xs">
            {preview.count} found{preview.total > preview.count ? ` (best of ${preview.total})` : ""}. Click one to drop it.
          </Typography.Text>
          <Space size="small" className="mt-1">
            <Button size="small" type="primary" onClick={onAcceptPreview} htmlType="button">
              Add (Enter)
            </Button>
            <Button size="small" onClick={onDiscardPreview} htmlType="button">
              Discard (Esc)
            </Button>
          </Space>
        </div>
      )}
      <Button
        icon={<SwapOutlined />}
        block
        htmlType="button"
        disabled={disabled || !canCopy}
        onClick={onCopyToOtherLayer}
        title={`Copy the selected polygons into the ${other} layer (T)`}
      >
        Copy to {other} (T)
      </Button>
    </Space>
  );
}
