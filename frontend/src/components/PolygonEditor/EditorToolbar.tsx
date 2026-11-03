import { Button, Card, Space, Divider } from "antd";
import {
  SaveOutlined,
  StopOutlined,
  EditOutlined,
  ScissorOutlined,
  MergeCellsOutlined,
  RobotOutlined,
  DeleteOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import AreaToolsPanel, { type AreaToolsPanelProps } from "./AreaToolsPanel";
import AIToolPanel from "./AIToolPanel";
import type { AIMode } from "../../hooks/useAISegmentation";

interface Props {
  type: "deadwood" | "forest_cover";
  isDrawing: boolean;
  hasSelection: boolean;
  selectionCount: number;
  isAIActive: boolean;
  isAIProcessing: boolean;
  onToggleDraw: () => void;
  onCutHole: () => void;
  onMerge: () => void;
  onClip: () => void;
  onToggleAI: () => void;
  /** Layer switch, area tools and copy between layers; editors without them leave this out. */
  areaTools?: AreaToolsPanelProps;
  /** What a click does while AI is on; with it, AI's options show under the AI button. */
  aiMode?: AIMode;
  onAIModeChange?: (mode: AIMode) => void;
  onDeleteSelected: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onSave: () => void;
  onCancel: () => void;
  position?: "top-right" | "top-left";
  title?: string; // Allow custom title
  className?: string; // Allow custom container classes like overriding top offset
}

export default function EditorToolbar({
  type,
  isDrawing,
  hasSelection,
  selectionCount,
  isAIActive,
  isAIProcessing,
  onToggleDraw,
  onCutHole,
  onMerge,
  onClip,
  onToggleAI,
  areaTools,
  aiMode,
  onAIModeChange,
  onDeleteSelected,
  onUndo,
  canUndo,
  onSave,
  onCancel,
  position = "top-right",
  title,
  className,
}: Props) {
  const displayTitle = title || `Editing ${type === "deadwood" ? "deadwood cover" : "tree cover"}`;
  const AREA_TOOL_NAMES = { add: "Add area", remove: "Remove area", find: "Find in area" } as const;
  const activeTool = isAIActive
    ? aiMode === "cut"
      ? "AI cut out"
      : "AI outline"
    : isDrawing
      ? "Draw"
      : areaTools?.action
        ? AREA_TOOL_NAMES[areaTools.action]
        : selectionCount > 0
          ? `Select (${selectionCount} selected)`
          : "Select";

  return (
    <div className={`absolute ${position === "top-right" ? "right-4" : "left-4"} ${className || "top-32"} z-20`}>
      <Card
        title={displayTitle}
        className="shadow-lg"
        style={{ width: areaTools ? 220 : 180 }}
        size="small"
      >
        <Space direction="vertical" size="small" className="w-full">
          <div
            className="flex items-center justify-between rounded-md bg-gray-100 px-2 py-1 text-xs"
            data-testid="editor-active-tool"
            aria-live="polite"
          >
            <span className="text-gray-500">Tool</span>
            <span className="font-semibold text-gray-800">{activeTool}</span>
          </div>
          {/* Draw Toggle */}
          <Button
            icon={isDrawing ? <StopOutlined /> : <EditOutlined />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleDraw();
            }}
            block
            type={isDrawing ? "primary" : "default"}
            htmlType="button"
            title="Draw polygon (A) - Click to draw vertices, or hold Shift for freehand"
          >
            {isDrawing ? "Stop (A)" : "Draw (A)"}
          </Button>

          {/* Cut Hole */}
          <Button
            icon={<ScissorOutlined />}
            onClick={onCutHole}
            disabled={!hasSelection || selectionCount !== 1}
            block
            title="Cut hole or trim (C) - Select one polygon, then draw. Hold Shift for freehand."
          >
            Cut (C) {hasSelection && selectionCount === 1 ? "✓" : ""}
          </Button>

          {/* Merge */}
          <Button
            icon={<MergeCellsOutlined />}
            onClick={onMerge}
            disabled={!hasSelection || selectionCount !== 2}
            block
            title="Merge 2 polygons (G) - Works with overlapping or nested polygons"
          >
            Merge (G) {hasSelection && selectionCount === 2 ? `✓` : ""}
          </Button>

          {/* Clip */}
          <Button
            icon={<ScissorOutlined rotate={90} />}
            onClick={onClip}
            disabled={!hasSelection || selectionCount !== 2}
            block
            title="Clip overlap (X) - Removes smaller polygon from larger"
          >
            Clip (X) {hasSelection && selectionCount === 2 ? `✓` : ""}
          </Button>

          {/* AI Segmentation */}
          <Button
            icon={<RobotOutlined />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleAI();
            }}
            loading={isAIProcessing}
            block
            type={isAIActive ? "primary" : "default"}
            title="AI (S): click a tree to outline it"
            htmlType="button"
          >
            {isAIActive ? "Stop AI (S)" : "AI (S)"}
          </Button>
          {isAIActive && aiMode && onAIModeChange && (
            <AIToolPanel mode={aiMode} onModeChange={onAIModeChange} isProcessing={isAIProcessing} />
          )}

          {areaTools && (
            <>
              <Divider style={{ margin: "4px 0" }} />
              <AreaToolsPanel {...areaTools} />
              <Divider style={{ margin: "4px 0" }} />
            </>
          )}

          {/* Delete */}
          <Button
            icon={<DeleteOutlined />}
            onClick={onDeleteSelected}
            disabled={!hasSelection || selectionCount === 0}
            danger
            block
            title="Delete selected (D)"
          >
            Delete (D) {hasSelection && selectionCount > 0 ? `(${selectionCount})` : ""}
          </Button>

          {/* Undo */}
          <Button
            icon={<UndoOutlined />}
            onClick={onUndo}
            disabled={!canUndo}
            block
            title="Undo last action (Ctrl/Cmd+Z)"
          >
            Undo (⌘Z)
          </Button>

          <Divider style={{ margin: "8px 0" }} />

          {/* Save/Cancel */}
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={onSave}
            block
            htmlType="button"
            title="Save changes (Ctrl/Cmd+S)"
          >
            Save (⌘S)
          </Button>

          <Button onClick={onCancel} block htmlType="button">
            Cancel
          </Button>
        </Space>
      </Card>
    </div>
  );
}
