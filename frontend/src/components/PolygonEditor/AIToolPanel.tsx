import { Segmented, Typography } from "antd";
import type { AIMode } from "../../hooks/useAISegmentation";
import type { HeldModifiers } from "../../hooks/useHeldModifiers";
import { keyLabels } from "../../utils/keyLabels";

interface AIToolPanelProps {
  mode: AIMode;
  onModeChange: (mode: AIMode) => void;
  isProcessing: boolean;
  held: HeldModifiers;
}

/**
 * Shown under the AI button while AI is on: what a click does now and the shortcuts. Holding
 * ⇧ or ⌥ highlights the action that the next click or drag will take.
 */
export default function AIToolPanel({
  mode,
  onModeChange,
  isProcessing,
  held,
}: AIToolPanelProps) {
  const { alt, shift } = keyLabels;
  const flipped = mode === "outline" ? "cut out" : "outline";
  const lines = [
    {
      key: "shift",
      active: held.shift && !held.alt,
      text: `${shift} drag: use a box · ${shift} click: add to the last outline`,
    },
    { key: "alt", active: held.alt, text: `${alt} click: ${flipped} once` },
  ];
  const now = isProcessing
    ? "Working on it…"
    : held.alt
      ? `Click to ${flipped} what is under the cursor.`
      : held.shift
        ? "Drag a box, or click to add to the last outline."
        : mode === "outline"
          ? "Click a tree to outline it."
          : "Click a gap or wrong part to cut it out of the layer.";
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
      <Typography.Text
        className="mt-1.5 block text-xs font-medium leading-snug text-gray-800"
        data-testid="ai-tool-now"
      >
        {now}
      </Typography.Text>
      <ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-[11px] leading-snug">
        {lines.map((line) => (
          <li
            key={line.key}
            className={
              line.active
                ? "rounded bg-purple-600 px-1 text-white"
                : "px-1 text-gray-500"
            }
            data-active={line.active}
          >
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
