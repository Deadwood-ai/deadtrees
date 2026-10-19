import { useMemo, useState } from "react";
import { Checkbox, Segmented } from "antd";
import {
  CONTEXT_SOURCE_LABELS,
  CONTEXT_SOURCES,
  contextAttribution,
  initialFrameStart,
} from "./benchmarkData";
import BenchmarkSignalChart from "./BenchmarkSignalChart";
import BenchmarkContextRow from "./BenchmarkContextRow";
import type { ContextSource, IBenchmarkSite } from "./types";

interface BenchmarkTemporalPanelProps {
  site: IBenchmarkSite;
}
export default function BenchmarkTemporalPanel({
  site,
}: BenchmarkTemporalPanelProps) {
  const available = CONTEXT_SOURCES.filter(
    (source) => site.contexts[source]?.length,
  );
  const [source, setSource] = useState<ContextSource>(available[0] || "planet");
  const [starts, setStarts] = useState(() => {
    const anchor = site.droneDate || `${site.year}-07-01`;
    return Object.fromEntries(
      CONTEXT_SOURCES.map((source) => [
        source,
        initialFrameStart(site.contexts[source] || [], anchor),
      ]),
    ) as Record<ContextSource, number>;
  });
  const [reference, setReference] = useState(true);
  // Stable between renders so the chart's smoothing is not recomputed on
  // unrelated state changes (e.g. the reference-polygon toggle).
  const start = starts[source];
  const windows = useMemo(
    () => ({
      [source]: (site.contexts[source] || []).slice(start, start + 3),
    }),
    [site, source, start],
  );
  const credits = [
    ...new Set(
      (windows[source] || [])
        .map((frame) => contextAttribution(frame, source))
        .filter(Boolean),
    ),
  ].join(" · ");
  return (
    <section className="db-temporal" aria-labelledby="db-temporal-heading">
      <div className="db-section-heading">
        <h2 id="db-temporal-heading">
          Temporal context of the drone reference
        </h2>
        <p>
          Centimetre-scale drone imagery resolves disturbance patterns in
          detail, but usually captures a single moment. Satellite time series
          and dated ancillary imagery help assess when disturbance occurred and
          whether it is consistent with the drone reference.
        </p>
      </div>
      <div className="db-temporal-grid">
        <BenchmarkSignalChart site={site} windows={windows} />
        <div className="db-context-stack">
          <h3 className="db-base-imagery-title">Base imagery</h3>
          <div className="db-context-stack-heading">
            <Segmented
              size="small"
              aria-label="Imagery source"
              value={source}
              onChange={(value) => setSource(value as ContextSource)}
              options={available.map((value) => ({
                value,
                label: CONTEXT_SOURCE_LABELS[value],
              }))}
            />
            <Checkbox
              checked={reference}
              disabled={
                !site.referencePolygons &&
                !available.some((source) =>
                  site.contexts[source]?.some(
                    (frame) => frame.referencePolygons,
                  ),
                )
              }
              onChange={(event) => setReference(event.target.checked)}
            >
              Show drone reference polygons
            </Checkbox>
          </div>
          {available
            .filter((value) => value === source)
            .map((source) => (
              <BenchmarkContextRow
                key={source}
                site={site}
                source={source}
                start={starts[source]}
                reference={reference}
                onStart={(start) =>
                  setStarts((current) => ({ ...current, [source]: start }))
                }
              />
            ))}
          {!available.length && (
            <p className="db-empty-frames">
              No dated RGB context is available for this site.
            </p>
          )}
          <p className="db-context-note">
            White outlines show the mapped drone reference. Planet dates are
            composite months.{credits && ` ${credits}.`}
          </p>
        </div>
      </div>
    </section>
  );
}
