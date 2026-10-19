import { CONTEXT_SOURCE_LABELS, CONTEXT_SOURCES } from "./benchmarkData";
import type { SignalChartModel } from "./signalChartModel";
import type { ContextSource, IBenchmarkFrame, IBenchmarkSite } from "./types";
interface BenchmarkImageDateLanesProps {
  model: SignalChartModel;
  site: IBenchmarkSite;
  windows: Partial<Record<ContextSource, IBenchmarkFrame[]>>;
}
const COLORS: Record<ContextSource, string> = {
  planet: "var(--db-planet-color)",
  google: "#697786",
  esri: "#7f7793",
};
export default function BenchmarkImageDateLanes({
  model,
  site,
  windows,
}: BenchmarkImageDateLanesProps) {
  const sources = CONTEXT_SOURCES.filter(
    (source) => windows[source] !== undefined,
  );
  return (
    <>
      {sources.map((source, index) => {
        const y = 282 + index * 24;
        const selected = new Set(windows[source]?.map((frame) => frame.image));
        return (
          <g key={source}>
            <text
              x="47"
              y={y + 4}
              textAnchor="end"
              className="db-date-lane-label"
            >
              {CONTEXT_SOURCE_LABELS[source]}
            </text>
            <line x1="56" x2="716" y1={y} y2={y} stroke="#e4e9df" />
            {(site.contexts[source] || [])
              .filter((frame) => model.inWindow(frame.date))
              .map((frame) =>
                selected.has(frame.image) ? (
                  <rect
                    key={frame.image}
                    x={model.x(frame.date) - 4}
                    y={y - 4}
                    width="8"
                    height="8"
                    rx="2"
                    fill={COLORS[source]}
                  >
                    <title>
                      {CONTEXT_SOURCE_LABELS[source]} displayed frame ·{" "}
                      {frame.date}
                    </title>
                  </rect>
                ) : (
                  <circle
                    key={frame.image}
                    cx={model.x(frame.date)}
                    cy={y}
                    r="1.8"
                    fill={COLORS[source]}
                    opacity="0.35"
                  >
                    <title>
                      {CONTEXT_SOURCE_LABELS[source]} available image ·{" "}
                      {frame.date}
                    </title>
                  </circle>
                ),
              )}
          </g>
        );
      })}
    </>
  );
}
