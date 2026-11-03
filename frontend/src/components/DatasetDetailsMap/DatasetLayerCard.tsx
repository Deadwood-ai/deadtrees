import { Button, Checkbox, Slider, Tooltip } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { mapColors } from "../../theme/mapColors";
import { palette } from "../../theme/palette";

/** What the map shows: one label layer, both, or the imagery alone. */
export type LayerView = "imagery" | "deadwood" | "forest_cover" | "both";
export type EditableLayer = "deadwood" | "forest_cover";

export interface LayerCardRow {
  view: LayerView;
  key: string;
  label: string;
  swatch: string | null;
  /** Shown instead of the row when the layer has no usable prediction. */
  disabledReason?: string;
}

export interface DatasetLayerCardProps {
  rows: LayerCardRow[];
  view: LayerView;
  onViewChange: (view: LayerView) => void;
  opacity: number;
  onOpacityChange: (value: number) => void;
  hasAOI: boolean;
  showAOI: boolean;
  onShowAOIChange: (show: boolean) => void;
  /** Set while editing: the rows pick the layer you edit instead of what you see. */
  editingLayer: EditableLayer | null;
  onEditLayer?: (layer: EditableLayer) => void;
  /** Layer that "Edit" (E) opens; null hides the button. */
  editTarget: EditableLayer | null;
  onStartEdit?: () => void;
}

const LAYER_NAME: Record<EditableLayer, string> = {
  deadwood: "deadwood",
  forest_cover: "tree cover",
};

/**
 * Bottom-left layer card of the dataset map, after the reference patch editor: number keys pick
 * what the map shows (explore) or which layer you edit (edit mode). Keys live in
 * useLayerCardKeys; this component only draws the card.
 */
export default function DatasetLayerCard({
  rows,
  view,
  onViewChange,
  opacity,
  onOpacityChange,
  hasAOI,
  showAOI,
  onShowAOIChange,
  editingLayer,
  onEditLayer,
  editTarget,
  onStartEdit,
}: DatasetLayerCardProps) {
  const editing = editingLayer !== null;
  const visibleRows = editing
    ? rows.filter((r) => r.view === "deadwood" || r.view === "forest_cover")
    : rows;
  const isActive = (row: LayerCardRow) =>
    editing ? row.view === editingLayer : row.view === view;

  return (
    <div
      className="pointer-events-auto w-60 rounded-xl border border-gray-200/70 bg-white/95 p-3 shadow-xl backdrop-blur-sm"
      data-testid="dataset-layer-card"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {editing ? "Layer you edit" : "Layers"}
        </span>
        <span className="text-[11px] text-gray-400">Space: imagery</span>
      </div>
      <div
        className="flex flex-col gap-1"
        role="radiogroup"
        aria-label={editing ? "Layer you edit" : "Visible layers"}
      >
        {visibleRows.map((row) => {
          const active = isActive(row);
          const disabled = !!row.disabledReason;
          const button = (
            <button
              key={row.view}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() =>
                editing
                  ? onEditLayer?.(row.view as EditableLayer)
                  : onViewChange(row.view)
              }
              className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition-colors ${
                active
                  ? "border-gray-800 bg-gray-50 font-medium"
                  : "border-transparent hover:bg-gray-50"
              } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
            >
              <kbd
                className="flex h-5 min-w-5 items-center justify-center rounded px-1 font-mono text-[11px] text-white"
                style={{
                  backgroundColor: active
                    ? palette.neutral[900]
                    : palette.neutral[500],
                }}
              >
                {row.key}
              </kbd>
              {row.swatch ? (
                <span
                  className="h-3 w-3 rounded-sm"
                  style={{ background: row.swatch }}
                />
              ) : (
                <span className="h-3 w-3 rounded-sm border border-gray-300 bg-white" />
              )}
              <span className="flex-1 text-gray-700">{row.label}</span>
            </button>
          );
          return disabled ? (
            <Tooltip
              key={row.view}
              title={row.disabledReason}
              placement="right"
            >
              <span>{button}</span>
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>

      {/* The editor draws its own layer, so opacity applies while exploring only. */}
      {!editing && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-500">Opacity</span>
          <Slider
            className="m-0 flex-1"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={onOpacityChange}
            tooltip={{ formatter: (v) => `${Math.round((v || 0) * 100)}%` }}
          />
        </div>
      )}
      {hasAOI && (
        <Checkbox
          checked={showAOI}
          onChange={(e) => onShowAOIChange(e.target.checked)}
          className="text-xs"
        >
          <span className="flex items-center gap-2 text-xs text-gray-600">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ border: `2px solid ${mapColors.aoi.stroke}` }}
            />
            AOI outline
          </span>
        </Checkbox>
      )}

      {!editing && editTarget && onStartEdit && (
        <Button
          block
          size="small"
          icon={<EditOutlined />}
          className="mt-2"
          onClick={onStartEdit}
        >
          Edit {LAYER_NAME[editTarget]} (E)
        </Button>
      )}
    </div>
  );
}
