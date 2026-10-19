import BenchmarkChartMarks from "./BenchmarkChartMarks";
import { createSignalChartModel, type SignalPoint } from "./signalChartModel";
import BenchmarkChartAxes from "./BenchmarkChartAxes";
import BenchmarkImageDateLanes from "./BenchmarkImageDateLanes";
import { useMemo, useState } from "react";
import { Checkbox, Select } from "antd";
import { benchmarkDate, benchmarkTime, CONTEXT_SOURCES } from "./benchmarkData";
import type {
  BenchmarkIndex,
  ContextSource,
  IBenchmarkFrame,
  IBenchmarkSite,
} from "./types";

interface BenchmarkSignalChartProps {
  site: IBenchmarkSite;
  windows: Partial<Record<ContextSource, IBenchmarkFrame[]>>;
}
const INDEX_LABELS: Record<BenchmarkIndex, string> = {
  ndvi: "NDVI",
  ndii: "NDII",
  evi: "EVI",
  kndvi: "kNDVI",
};
export default function BenchmarkSignalChart({
  site,
  windows,
}: BenchmarkSignalChartProps) {
  const [index, setIndex] = useState<BenchmarkIndex>("ndvi");
  const [fullRecord, setFullRecord] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const frames = useMemo(() => Object.values(windows).flat(), [windows]);
  const sentinel = useMemo(
    () =>
      [...site.series]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((row) => ({ date: row.date, value: row[index] })),
    [site.series, index],
  );
  const planet = useMemo(
    () =>
      [...(site.planetSeries || [])]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((row) => ({ date: row.date, value: row.gcc })),
    [site.planetSeries],
  );
  const model = useMemo(
    () => createSignalChartModel(site, frames, sentinel, planet, fullRecord),
    [site, frames, sentinel, planet, fullRecord],
  );
  const { minimum, maximum, visibleSentinel, visiblePlanet } = model;
  const outside = frames.filter((frame) => !model.inWindow(frame.date)).length;
  const sources = CONTEXT_SOURCES.filter(
    (source) => windows[source] !== undefined,
  );
  const nearest = (points: SignalPoint[]) =>
    !points.length || hover == null
      ? null
      : points.reduce((best, row) =>
          Math.abs(benchmarkTime(row.date) - hover) <
          Math.abs(benchmarkTime(best.date) - hover)
            ? row
            : best,
        );
  const sentinelHover = nearest(visibleSentinel),
    planetHover = nearest(visiblePlanet);
  return (
    <div className="db-signal-panel">
      <h3 className="db-time-range-title">
        {fullRecord ? "Full record" : "Disturbance window"}
      </h3>
      <div className="db-chart-controls">
        <label className="flex items-center gap-2">
          Sentinel-2 index
          <Select
            size="small"
            className="min-w-24"
            value={index}
            onChange={(value: BenchmarkIndex) => setIndex(value)}
            options={Object.entries(INDEX_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </label>
        <Checkbox
          checked={!fullRecord}
          onChange={(event) => setFullRecord(!event.target.checked)}
        >
          Zoom to disturbance window
        </Checkbox>
      </div>
      <div className="db-chart-container">
        <svg
          viewBox={`0 0 780 ${280 + sources.length * 24}`}
          className="db-signal-chart"
          role="img"
          tabIndex={0}
          aria-label={`Sentinel-2 ${INDEX_LABELS[index]} on the left scale and Planet RGB greenness GCC on the right scale. Hover or use arrow keys to inspect dated observations.`}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const times = [
              ...new Set(
                [...visibleSentinel, ...visiblePlanet].map((row) =>
                  benchmarkTime(row.date),
                ),
              ),
            ].sort((a, b) => a - b);
            if (!times.length) return;
            const current = times.reduce(
              (best, time, position) =>
                Math.abs(time - (hover ?? minimum)) <
                Math.abs(times[best] - (hover ?? minimum))
                  ? position
                  : best,
              0,
            );
            setHover(
              times[
                Math.max(
                  0,
                  Math.min(
                    times.length - 1,
                    current + (event.key === "ArrowRight" ? 1 : -1),
                  ),
                )
              ],
            );
          }}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const point = ((event.clientX - bounds.left) / bounds.width) * 780;
            setHover(
              Math.max(
                minimum,
                Math.min(
                  maximum,
                  minimum + ((point - 56) / 660) * (maximum - minimum),
                ),
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
        >
          <BenchmarkChartAxes model={model} indexLabel={INDEX_LABELS[index]} />
          <BenchmarkChartMarks model={model} site={site} hover={hover} />
          <BenchmarkImageDateLanes
            model={model}
            site={site}
            windows={windows}
          />
        </svg>
      </div>
      <div className="db-chart-readout" aria-live="polite">
        {hover == null ? (
          <span>Hover or use ← → to inspect observation dates and values.</span>
        ) : (
          <>
            <span>
              <i className="db-sentinel-key" />
              {INDEX_LABELS[index]}:{" "}
              {sentinelHover?.value == null
                ? "missing"
                : sentinelHover.value.toFixed(3)}{" "}
              {sentinelHover && `· ${benchmarkDate(sentinelHover.date)}`}
            </span>
            <span>
              <i className="db-planet-key" />
              GCC:{" "}
              {planetHover?.value == null
                ? "unavailable"
                : planetHover.value.toFixed(3)}{" "}
              {planetHover && `· ${benchmarkDate(planetHover.date)}`}
            </span>
          </>
        )}
      </div>
      <div className="db-chart-legend">
        <span>
          <i className="db-sentinel-key" />
          Sentinel-2 · left scale
        </span>
        <span>
          <i className="db-planet-key" />
          Planet GCC · right scale
        </span>
        <span>
          <i className="db-frame-key" />
          Displayed image dates
        </span>
        <span className="db-context-date-key">· Available image dates</span>
      </div>
      <p className="db-chart-note">
        GCC = G / (R + G + B), averaged over valid Planet RGB pixels. Null
        values remain missing. Lines show robust LOWESS trends (120-day
        Sentinel, 240-day Planet windows); faint points and hover values are
        original observations. Trends stop across gaps longer than 45 days
        (Sentinel) or 100 days (Planet), and at missing Planet observations.
        Sentinel trends use gentler fits within 30 days of gap edges; stretches
        with fewer than four nearby observations show points only. Smoothing can
        soften abrupt changes and does not establish the disturbance date.
        {outside > 0 &&
          ` ${outside} displayed image dates lie outside this close-up; uncheck Zoom to disturbance window to view the full record.`}
      </p>
    </div>
  );
}
