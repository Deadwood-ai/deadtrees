import { benchmarkTime } from "./benchmarkData";
import type { IBenchmarkSite, IBenchmarkFrame } from "./types";
export interface SignalPoint {
  date: string;
  value: number | null;
}
export function lineSegments(
  points: SignalPoint[],
  x: (date: string) => number,
  y: (value: number) => number,
  maxGapDays?: number,
): string[] {
  const lines: string[] = [];
  let segment: string[] = [];
  let previousTime: number | null = null;
  points.forEach((point) => {
    if (point.value == null || !Number.isFinite(point.value)) {
      // Sentinel can bridge short gaps between valid observations without
      // filling in missing values. Planet retains explicit missing composites.
      if (maxGapDays !== undefined) return;
      if (segment.length) lines.push(segment.join(" "));
      segment = [];
    } else {
      const time = benchmarkTime(point.date);
      if (
        maxGapDays !== undefined &&
        previousTime !== null &&
        time - previousTime > maxGapDays * 86400000
      ) {
        if (segment.length) lines.push(segment.join(" "));
        segment = [];
      }
      segment.push(`${x(point.date)},${y(point.value)}`);
      previousTime = time;
    }
  });
  if (segment.length) lines.push(segment.join(" "));
  return lines;
}

export function createSignalChartModel(
  site: IBenchmarkSite,
  frames: IBenchmarkFrame[],
  sentinel: SignalPoint[],
  planet: SignalPoint[],
  fullRecord: boolean,
) {
  const allTimes = [
    ...sentinel,
    ...planet,
    ...frames,
    ...(site.contexts.google || []),
    ...(site.contexts.esri || []),
  ]
    .map((row) => benchmarkTime(row.date))
    .filter(Number.isFinite);
  const minimum = Math.min(
    benchmarkTime(`${site.year - 1}-01-01`),
    ...(fullRecord ? allTimes : []),
  );
  const maximum = Math.max(
    benchmarkTime(`${site.year}-12-31`),
    ...(fullRecord ? allTimes : []),
  );
  const inWindow = (date: string) =>
    benchmarkTime(date) >= minimum && benchmarkTime(date) <= maximum;
  const visibleSentinel = sentinel.filter((row) => inWindow(row.date));
  const visiblePlanet = planet.filter((row) => inWindow(row.date));
  const valid = visibleSentinel.filter(
    (row): row is { date: string; value: number } =>
      row.value != null && Number.isFinite(row.value),
  );
  const low = valid.length
    ? Math.floor((Math.min(...valid.map((row) => row.value)) - 0.05) * 10) / 10
    : 0;
  const high = valid.length
    ? Math.ceil((Math.max(...valid.map((row) => row.value)) + 0.05) * 10) / 10
    : 1;
  const x = (date: string) =>
    56 + ((benchmarkTime(date) - minimum) / (maximum - minimum || 1)) * 660;
  const ySentinel = (value: number) =>
    227 - ((value - low) / (high - low || 1)) * 166;
  const validPlanet = visiblePlanet.filter(
    (row): row is { date: string; value: number } =>
      row.value != null && Number.isFinite(row.value),
  );
  const planetLow = validPlanet.length
    ? Math.max(
        0,
        Math.floor(
          (Math.min(...validPlanet.map((row) => row.value)) - 0.015) * 100,
        ) / 100,
      )
    : 0;
  const planetHigh = validPlanet.length
    ? Math.min(
        1,
        Math.ceil(
          (Math.max(...validPlanet.map((row) => row.value)) + 0.015) * 100,
        ) / 100,
      )
    : 1;
  const yPlanet = (value: number) =>
    227 - ((value - planetLow) / (planetHigh - planetLow || 1)) * 166;
  const ticks = [0, 1, 2, 3, 4].map(
    (value) => minimum + ((maximum - minimum) * value) / 4,
  );

  return {
    minimum,
    maximum,
    inWindow,
    visibleSentinel,
    visiblePlanet,
    valid,
    low,
    high,
    x,
    ySentinel,
    yPlanet,
    planetLow,
    planetHigh,
    ticks,
  };
}
export type SignalChartModel = ReturnType<typeof createSignalChartModel>;
