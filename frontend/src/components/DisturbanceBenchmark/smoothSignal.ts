import { benchmarkTime } from "./benchmarkData";
import type { SignalPoint } from "./signalChartModel";

const DAY = 86400000;
type Observation = { date: string; value: number; time: number };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return (
    (sorted[middle] + sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)]) / 2
  );
};

// Robust local linear regression in elapsed days (not observation index).
// Fixed windows retain seasonal structure; bisquare residual weights reduce
// isolated outliers. Original observations and hover values remain untouched.
function lowess(
  points: Observation[],
  windowDays: number,
  stabilizeEdges: boolean,
): Observation[] {
  if (points.length < 4) return stabilizeEdges ? [] : points;
  let robustness = points.map(() => 1);
  let fitted = points.map((p) => p.value);
  for (let pass = 0; pass < 4; pass++) {
    fitted = points.map((target) => {
      let sw = 0,
        sx = 0,
        sy = 0,
        sxx = 0,
        sxy = 0,
        neighbours = 0;
      points.forEach((point, j) => {
        const dx = (point.time - target.time) / DAY;
        const distance = Math.abs(dx) / (windowDays / 2);
        if (distance >= 1) return;
        neighbours++;
        const weight = (1 - distance ** 3) ** 3 * robustness[j];
        sw += weight;
        sx += weight * dx;
        sy += weight * point.value;
        sxx += weight * dx * dx;
        sxy += weight * dx * point.value;
      });
      if (neighbours < 4) return target.value;
      // On a nearly constant series the residual MAD can be zero, rejecting
      // an entire spike-affected neighbourhood. Recover its local median,
      // rather than reintroducing the original spike as a fallback.
      if (sw < 1e-10)
        return median(
          points
            .filter(
              (p) => Math.abs(p.time - target.time) < (windowDays / 2) * DAY,
            )
            .map((p) => p.value),
        );
      const denominator = sw * sxx - sx * sx;
      const linear =
        Math.abs(denominator) < 1e-10
          ? sy / sw
          : (sy * sxx - sx * sxy) / denominator;
      if (!stabilizeEdges) return linear;
      // One-sided local linear fits have high leverage at gap boundaries.
      // Blend toward the robust local mean only within 30 days of an edge.
      const edgeDays =
        Math.min(
          target.time - points[0].time,
          points[points.length - 1].time - target.time,
        ) / DAY;
      const fraction = Math.min(1, edgeDays / 30);
      const blend = fraction * fraction * (3 - 2 * fraction);
      return blend * linear + ((1 - blend) * sy) / sw;
    });
    const residuals = points.map((p, i) => Math.abs(p.value - fitted[i]));
    const scale = Math.max(1e-8, 6 * median(residuals));
    robustness = residuals.map((residual) =>
      residual >= scale ? 0 : (1 - (residual / scale) ** 2) ** 2,
    );
  }
  return points
    .map((point, i) => ({ ...point, value: fitted[i] }))
    .filter(
      (point) =>
        !stabilizeEdges ||
        points.filter(
          (other) => Math.abs(other.time - point.time) < (windowDays / 2) * DAY,
        ).length >= 4,
    );
}

export function smoothSignal(
  points: SignalPoint[],
  windowDays: number,
  maxGapDays: number,
  breakOnMissing = false,
  stabilizeEdges = false,
): Observation[][] {
  const segments: Observation[][] = [];
  let segment: Observation[] = [];
  const flush = () => {
    if (segment.length) {
      const fitted = lowess(segment, windowDays, stabilizeEdges);
      let run: Observation[] = [];
      for (const point of fitted) {
        if (
          run.length &&
          point.time - run[run.length - 1].time > maxGapDays * DAY
        ) {
          segments.push(run);
          run = [];
        }
        run.push(point);
      }
      segments.push(run);
    }
    segment = [];
  };
  // Monthly and quarterly records can share dates; use their median for the trend.
  // Both original observations remain available in the chart/readout.
  const grouped = new Map<number, { date: string; values: number[] }>();
  for (const point of points) {
    const time = benchmarkTime(point.date);
    if (!Number.isFinite(time)) continue;
    const group = grouped.get(time) || { date: point.date, values: [] };
    if (point.value != null && Number.isFinite(point.value))
      group.values.push(point.value);
    grouped.set(time, group);
  }
  for (const [time, group] of [...grouped.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    if (!group.values.length) {
      if (breakOnMissing) flush();
      continue;
    }
    if (
      segment.length &&
      time - segment[segment.length - 1].time > maxGapDays * DAY
    )
      flush();
    segment.push({ date: group.date, time, value: median(group.values) });
  }
  flush();
  return segments;
}

export function smoothPaths(
  segments: Observation[][],
  x: (date: string) => number,
  y: (value: number) => number,
): string[] {
  return segments
    .filter((segment) => segment.length >= 2)
    .map((segment) => {
      const points = segment.map((point) => ({
        x: x(point.date),
        y: y(point.value),
      }));
      const widths = points.slice(1).map((point, i) => point.x - points[i].x);
      const slopes = widths.map(
        (width, i) => (points[i + 1].y - points[i].y) / width,
      );
      // Monotone cubic Hermite interpolation: shared tangents avoid a flat
      // shoulder at every observation. Limit tangents to prevent overshoot.
      const tangents = points.map((_, i) => {
        if (i === 0) return slopes[0];
        if (i === points.length - 1) return slopes[i - 1];
        const before = slopes[i - 1],
          after = slopes[i];
        if (before * after <= 0) return 0;
        const w1 = 2 * widths[i] + widths[i - 1];
        const w2 = widths[i] + 2 * widths[i - 1];
        const harmonic = (w1 + w2) / (w1 / before + w2 / after);
        return (
          Math.sign(harmonic) *
          Math.min(
            Math.abs(harmonic),
            3 * Math.min(Math.abs(before), Math.abs(after)),
          )
        );
      });
      let path = `M ${points[0].x} ${points[0].y}`;
      for (let i = 0; i < slopes.length; i++) {
        const previous = points[i],
          next = points[i + 1];
        const third = widths[i] / 3;
        path += ` C ${previous.x + third} ${previous.y + tangents[i] * third}, ${next.x - third} ${next.y - tangents[i + 1] * third}, ${next.x} ${next.y}`;
      }
      return path;
    });
}
