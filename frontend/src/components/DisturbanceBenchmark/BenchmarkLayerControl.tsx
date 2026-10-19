import { Select } from "antd";
import type { IBenchmarkEvaluation } from "./types";

export default function BenchmarkLayerControl({
  layers,
  selected,
  onSelect,
}: {
  layers: NonNullable<IBenchmarkEvaluation["layers"]>;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const layer = layers[selected];
  if (!layer) return null;
  return (
    <div className="db-raw-layer-control">
      <Select
        size="small"
        className="w-full"
        aria-label="Supplied satellite layer"
        value={selected}
        onChange={onSelect}
        options={layers.map((item, index) => ({
          value: index,
          label: item.label,
        }))}
      />
      <div className="db-raw-legend">
        <span>
          {layer.minimum.toLocaleString("en-GB", { maximumFractionDigits: 2 })}
        </span>
        <span
          className="db-raw-gradient"
          aria-label="Blue to orange source-value scale"
        />
        <span>
          {layer.maximum.toLocaleString("en-GB", { maximumFractionDigits: 2 })}
        </span>
      </div>
      <small>
        Source values · zero transparent · no classification threshold
      </small>
    </div>
  );
}
