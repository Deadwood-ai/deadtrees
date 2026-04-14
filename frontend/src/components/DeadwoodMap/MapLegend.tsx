import { EnvironmentOutlined } from "@ant-design/icons";
import { mapColors } from "../../theme/mapColors";
import { palette } from "../../theme/palette";

interface ClickedValues {
  forestPct: number;
  deadwoodPct: number;
}

interface MapLegendProps {
  clickedValues: ClickedValues | null;
  showForest: boolean;
  showDeadwood: boolean;
  embedded?: boolean;
}

// Gradient bar with optional value indicator
const GradientBar = ({
  gradientClass,
  value,
  indicatorColor,
}: {
  gradientClass: string;
  value: number | null;
  indicatorColor: string;
}) => (
  <div className="relative h-3 w-full overflow-visible rounded">
    <div className={`h-full w-full rounded ${gradientClass}`} />
    {value !== null && (
      <div
        className="absolute top-[-2px] h-[calc(100%+4px)] w-0.5"
        style={{
          left: `${value}%`,
          backgroundColor: indicatorColor,
          boxShadow: "0 0 2px rgba(0,0,0,0.3)",
        }}
      />
    )}
  </div>
);

const MapLegend = ({ clickedValues, showForest, showDeadwood, embedded = false }: MapLegendProps) => {
  return (
    <div
      className={
        embedded
          ? "flex w-full flex-col rounded-xl border border-gray-200/70 bg-white/90 p-3"
          : "flex w-52 flex-col rounded-2xl border border-gray-200/60 bg-white/95 p-4 shadow-xl backdrop-blur-sm pointer-events-auto"
      }
    >
      {/* Header */}
      <div className="mb-2">
        <div className="text-sm font-medium text-gray-700">Fractional Cover</div>
        <div className="text-xs text-gray-400">Sentinel-2 based</div>
      </div>

      {/* Tree - only show when active */}
      {showForest && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: mapColors.forest.fill }} />
              <span className="text-xs text-gray-600">Tree</span>
            </div>
            <span className="text-xs text-gray-400">0–100%</span>
          </div>
          <GradientBar
            gradientClass={`bg-gradient-to-r ${mapColors.forest.gradient}`}
            value={clickedValues?.forestPct ?? null}
            indicatorColor={palette.neutral[900]}
          />
        </div>
      )}

      {/* Standing Deadwood - only show when active */}
      {showDeadwood && showForest && <div className="mt-2" />}
      {showDeadwood && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: mapColors.deadwood.fill }} />
              <span className="text-xs text-gray-600">Standing Deadwood</span>
            </div>
            <span className="text-xs text-gray-400">0–100%</span>
          </div>
          <GradientBar
            gradientClass={`bg-gradient-to-r ${mapColors.deadwood.gradient}`}
            value={clickedValues?.deadwoodPct ?? null}
            indicatorColor={palette.neutral[900]}
          />
        </div>
      )}

      {/* Clicked Location Values - only show active layer value */}
      <div className="mt-2 border-t border-gray-100 pt-2">
        <div className="mb-1 flex items-center gap-1 text-xs font-medium text-gray-500">
          <EnvironmentOutlined />
          <span>Clicked Location</span>
        </div>

        {clickedValues ? (
          <div className="flex text-xs">
            {showForest && (
              <div className="flex items-center gap-1">
                <span className="text-gray-500">Tree:</span>
                <span className="font-semibold" style={{ color: mapColors.forest.text }}>
                  {clickedValues.forestPct}%
                </span>
              </div>
            )}
            {showDeadwood && (
              <div className="flex items-center gap-1">
                <span className="text-gray-500">Standing Deadwood:</span>
                <span className="font-semibold" style={{ color: mapColors.deadwood.text }}>
                  {clickedValues.deadwoodPct}%
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-400">Click on map to see values</div>
        )}
      </div>
    </div>
  );
};

export default MapLegend;
