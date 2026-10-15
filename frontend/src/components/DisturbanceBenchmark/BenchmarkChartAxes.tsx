import type { SignalChartModel } from "./signalChartModel";
interface BenchmarkChartAxesProps {
  model: SignalChartModel;
  indexLabel: string;
}
export default function BenchmarkChartAxes({
  model,
  indexLabel,
}: BenchmarkChartAxesProps) {
  const { low, high, planetLow, planetHigh, ticks, minimum, maximum } = model;
  return (
    <>
      <text
        transform="translate(14,144) rotate(-90)"
        textAnchor="middle"
        className="db-axis-sentinel"
      >
        Sentinel-2 {indexLabel}
      </text>
      <text
        transform="translate(770,144) rotate(90)"
        textAnchor="middle"
        className="db-axis-planet"
      >
        Planet GCC
      </text>
      {[0, 1, 2, 3].map((value) => (
        <g key={value}>
          <line
            x1="56"
            x2="716"
            y1={227 - (value * 166) / 3}
            y2={227 - (value * 166) / 3}
            stroke="#e5ebe4"
          />
          <text
            x="44"
            y={231 - (value * 166) / 3}
            textAnchor="end"
            className="db-axis-sentinel"
          >
            {(low + ((high - low) * value) / 3).toFixed(1)}
          </text>
          <text x="729" y={231 - (value * 166) / 3} className="db-axis-planet">
            {(planetLow + ((planetHigh - planetLow) * value) / 3).toFixed(2)}
          </text>
        </g>
      ))}
      {ticks.map((time) => (
        <text
          key={time}
          x={56 + ((time - minimum) / (maximum - minimum || 1)) * 660}
          y="254"
          textAnchor="middle"
        >
          {new Date(time).toLocaleDateString("en-GB", {
            month: "short",
            year: "2-digit",
            timeZone: "UTC",
          })}
        </text>
      ))}
    </>
  );
}
