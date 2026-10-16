import { useState } from "react";
import { useBenchmarkAsset } from "./BenchmarkAccess";
import { benchmarkDate, benchmarkTime } from "./benchmarkData";
import BenchmarkContextGallery from "./BenchmarkContextGallery";
import { BenchmarkPager } from "./BenchmarkControls";
import ReferencePolygonOverlay from "./ReferencePolygonOverlay";
import type { ContextSource, IBenchmarkSite } from "./types";
interface BenchmarkContextRowProps {
  site: IBenchmarkSite;
  source: ContextSource;
  start: number;
  reference: boolean;
  onStart: (start: number) => void;
}
const SOURCE_LABELS: Record<ContextSource, string> = {
  planet: "Planet",
  google: "Google",
  esri: "Esri",
};
export default function BenchmarkContextRow({
  site,
  source,
  start,
  reference,
  onStart,
}: BenchmarkContextRowProps) {
  const benchmarkAsset = useBenchmarkAsset();
  const [active, setActive] = useState<number | null>(null);
  const frames = site.contexts[source] || [];
  const visible = frames.slice(start, start + 3);
  const nearest = frames.reduce(
    (best, frame) =>
      Math.abs(benchmarkTime(frame.date) - benchmarkTime(site.droneDate)) <
      Math.abs(benchmarkTime(best.date) - benchmarkTime(site.droneDate))
        ? frame
        : best,
    frames[0],
  );
  return (
    <section
      className="db-context-panel"
      aria-label={`${SOURCE_LABELS[source]} dated image sequence`}
    >
      <div className="db-context-controls">
        <div>
          <p>
            {source === "planet"
              ? "Monthly RGB composites"
              : "Supplied dated RGB imagery"}
          </p>
        </div>
        <BenchmarkPager
          position={`${start + 1}–${Math.min(start + 3, frames.length)} / ${frames.length}`}
          label={`${SOURCE_LABELS[source]} image window`}
          canPrevious={start > 0}
          canNext={start + 3 < frames.length}
          onPrevious={() => onStart(Math.max(0, start - 1))}
          onNext={() =>
            onStart(Math.min(Math.max(0, frames.length - 3), start + 1))
          }
        />
      </div>
      <div className="db-context-frames">
        {visible.map((frame, offset) => (
          <figure key={frame.image}>
            <button
              className="db-context-frame-image db-context-enlarge"
              onClick={() => setActive(start + offset)}
              aria-label={`Compare ${SOURCE_LABELS[source]} imagery from ${benchmarkDate(frame.date)} with drone imagery`}
              style={{ aspectRatio: `${site.width} / ${site.height}` }}
            >
              <img
                src={benchmarkAsset(frame.image)}
                alt={`${SOURCE_LABELS[source]} RGB imagery, ${benchmarkDate(frame.date)}`}
                loading="lazy"
              />
              {reference && (
                <ReferencePolygonOverlay
                  polygons={frame.referencePolygons || site.referencePolygons}
                />
              )}
            </button>
            <figcaption>
              <span>
                {!site.droneDate
                  ? frame.compositeType === "quarterly"
                    ? "Quarterly composite"
                    : source === "planet"
                      ? "Monthly composite"
                      : "Supplied image date"
                  : frame === nearest
                    ? "Nearest drone date"
                    : benchmarkTime(frame.date) < benchmarkTime(site.droneDate)
                      ? "Before drone date"
                      : "After drone date"}
              </span>
              <strong>
                {frame.displayDate ||
                  (frame.date ? benchmarkDate(frame.date) : "Date NA")}
              </strong>
            </figcaption>
          </figure>
        ))}
      </div>
      {active !== null && (
        <BenchmarkContextGallery
          site={site}
          frames={frames}
          label={SOURCE_LABELS[source]}
          source={source}
          initialIndex={active}
          initialReference={reference}
          onClose={() => setActive(null)}
        />
      )}
    </section>
  );
}
