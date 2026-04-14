import type { DatasetMapColorMode } from "./DatasetMap";

interface DatasetMapColorControlProps {
  colorMode: DatasetMapColorMode;
}

const getLegendItems = (colorMode: DatasetMapColorMode): Array<{ label: string; color: string }> => {
  if (colorMode === "labels") {
    return [
      { label: "Has labels", color: "#1B5E35" },
      { label: "Predictions only", color: "#2E7AC0" },
      { label: "No labels/preds", color: "#6B7280" },
    ];
  }

  if (colorMode === "year") {
    return [
      { label: "2024+", color: "#EC4899" },
      { label: "2021-2023", color: "#58A67A" },
      { label: "2018-2020", color: "#355F8D" },
      { label: "< 2018", color: "#2C1E7A" },
    ];
  }

  return [
    { label: "High quality", color: "#29D280" },
    { label: "Medium quality", color: "#FFB31C" },
    { label: "Needs review", color: "#EF4444" },
    { label: "Unknown", color: "#6B7280" },
  ];
};

export default function DatasetMapColorControl({ colorMode }: DatasetMapColorControlProps) {
  const legendItems = getLegendItems(colorMode);

  return (
    <div className="w-56 rounded-2xl border border-gray-200/60 bg-white/95 p-4 shadow-xl backdrop-blur-sm pointer-events-auto">
      <div className="mb-3 text-sm font-medium text-gray-700">Acquisition Year</div>
      <div className="rounded-lg border border-gray-100 bg-gray-50/70 px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {legendItems.map((item) => (
            <div key={item.label} className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[11px] text-gray-700 ring-1 ring-gray-200/70">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
