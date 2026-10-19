import { useMemo } from "react";
import { smoothSignal, smoothPaths } from "./smoothSignal";
import { type SignalChartModel } from "./signalChartModel";
import type { IBenchmarkSite } from "./types";
import { benchmarkDate } from "./benchmarkData";
interface BenchmarkChartMarksProps {
  model: SignalChartModel;
  site: IBenchmarkSite;
  hover: number | null;
}
export default function BenchmarkChartMarks({
  model,
  site,
  hover,
}: BenchmarkChartMarksProps) {
  const {
    x,
    ySentinel,
    yPlanet,
    visibleSentinel,
    visiblePlanet,
    valid,
    minimum,
    maximum,
  } = model;
  const sentinelTrend = useMemo(
    () => smoothSignal(visibleSentinel, 120, 45, false, true),
    [visibleSentinel],
  );
  const planetTrend = useMemo(
    () => smoothSignal(visiblePlanet, 240, 100, true),
    [visiblePlanet],
  );
  const droneX = x(site.droneDate);
  return (
    <>
      {smoothPaths(sentinelTrend, x, ySentinel).map((points, i) => (
        <path
          key={`s-${i}`}
          d={points}
          fill="none"
          stroke="var(--db-sentinel-color)"
          strokeWidth="2.2"
          strokeOpacity="0.85"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {valid.map((row) => (
        <circle
          key={row.date}
          cx={x(row.date)}
          cy={ySentinel(row.value)}
          r="1.8"
          opacity="0.35"
          fill="var(--db-sentinel-color)"
        />
      ))}
      {smoothPaths(planetTrend, x, yPlanet).map((points, i) => (
        <path
          key={`p-${i}`}
          d={points}
          fill="none"
          stroke="var(--db-planet-color)"
          strokeWidth="2.2"
          strokeOpacity="0.85"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {visiblePlanet
        .filter((row) => row.value != null)
        .map((row, index) => (
          <circle
            key={`${row.date}-${index}`}
            cx={x(row.date)}
            cy={yPlanet(row.value!)}
            r="2.5"
            opacity="0.45"
            fill="var(--db-planet-color)"
            stroke="white"
            strokeWidth="1"
          />
        ))}
      {droneX >= 56 && droneX <= 716 && (
        <g>
          <title>Drone acquisition: {benchmarkDate(site.droneDate)}</title>
          <line
            x1={droneX}
            x2={droneX}
            y1="44"
            y2="227"
            stroke="#65745e"
            strokeDasharray="4 4"
          />
          <text x={droneX} y="38" textAnchor="middle">
            Drone date
          </text>
        </g>
      )}
      {hover != null && hover >= minimum && hover <= maximum && (
        <line
          x1={56 + ((hover - minimum) / (maximum - minimum)) * 660}
          x2={56 + ((hover - minimum) / (maximum - minimum)) * 660}
          y1="48"
          y2="227"
          stroke="#879b7b"
          strokeDasharray="2 3"
        />
      )}
    </>
  );
}
