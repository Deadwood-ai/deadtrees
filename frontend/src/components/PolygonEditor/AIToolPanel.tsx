import { Segmented, Typography } from "antd";
import type { AIMode } from "../../hooks/useAISegmentation";
import { keyLabels } from "../../utils/keyLabels";

interface AIToolPanelProps {
  mode: AIMode;
  onModeChange: (mode: AIMode) => void;
  isProcessing: boolean;
}

/** Shown under the AI button while AI is on: what a click does now, and the shortcuts. */
export default function AIToolPanel({
  mode,
  onModeChange,
  isProcessing,
}: AIToolPanelProps) {
  const { alt, shift } = keyLabels;
  return (
    <div
      className="rounded-md border border-purple-200 bg-purple-50 p-2"
      data-testid="ai-tool-panel"
    >
      <Segmented
        block
        size="small"
        value={mode}
        onChange={(value) => onModeChange(value as AIMode)}
        options={[
          { label: "Outline", value: "outline" },
          { label: "Cut out", value: "cut" },
        ]}
      />
      <Typography.Text className="mt-1.5 block text-xs leading-snug text-gray-700">
        {isProcessing
          ? "Working on it…"
          : mode === "outline"
            ? "Click a tree to outline it."
            : "Click a gap or wrong part to cut it out of the layer."}
      </Typography.Text>
      <ul className="m-0 mt-1 list-none p-0 text-[11px] leading-snug text-gray-500">
        <li>{shift} drag: use a box instead</li>
        <li>{shift} click: add to the last outline</li>
        <li>
          {alt} click: {mode === "outline" ? "cut out" : "outline"} once
        </li>
      </ul>
    </div>
  );
}
