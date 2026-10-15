import { useState } from "react";
import { contextAttribution, initialFrameStart } from "./benchmarkData";
import BenchmarkSignalChart from "./BenchmarkSignalChart";
import BenchmarkContextRow from "./BenchmarkContextRow";
import type { ContextSource, IBenchmarkSite } from "./types";

interface BenchmarkTemporalPanelProps {
  site: IBenchmarkSite;
}
export default function BenchmarkTemporalPanel({
  site,
}: BenchmarkTemporalPanelProps) {
  const available = (["planet", "google", "esri"] as ContextSource[]).filter(
    (source) => site.contexts[source]?.length,
  );
  const [source, setSource] = useState<ContextSource>(available[0] || "planet");
  const [starts, setStarts] = useState<Record<ContextSource, number>>(() => ({
    planet: initialFrameStart(
      site.contexts.planet || [],
      site.droneDate || `${site.year}-07-01`,
    ),
    google: initialFrameStart(
      site.contexts.google || [],
      site.droneDate || `${site.year}-07-01`,
    ),
    esri: initialFrameStart(
      site.contexts.esri || [],
      site.droneDate || `${site.year}-07-01`,
    ),
  }));
  const [reference, setReference] = useState(true);
  const windows = Object.fromEntries(
    [source].map((source) => [
      source,
      (site.contexts[source] || []).slice(starts[source], starts[source] + 3),
    ]),
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
            <div className="db-region-tabs" aria-label="Imagery source">
              {available.map((value) => (
                <button
                  key={value}
                  aria-pressed={source === value}
                  onClick={() => setSource(value)}
                >
                  {value === "planet"
                    ? "Planet"
                    : value === "google"
                      ? "Google"
                      : "Esri"}
                </button>
              ))}
            </div>
            <label className="db-checkbox">
              <input
                type="checkbox"
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
              />
              Show drone reference polygons
            </label>
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
