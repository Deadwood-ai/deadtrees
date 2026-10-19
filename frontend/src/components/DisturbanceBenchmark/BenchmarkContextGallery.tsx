import { useRef, useState } from "react";
import { Checkbox, Modal } from "antd";
import { benchmarkDate, contextAttribution } from "./benchmarkData";
import BenchmarkComparisonViewport from "./BenchmarkComparisonViewport";
import { BenchmarkPager, BenchmarkZoomControl } from "./BenchmarkControls";
import type { ContextSource, IBenchmarkFrame, IBenchmarkSite } from "./types";

interface BenchmarkContextGalleryProps {
  site: IBenchmarkSite;
  frames: IBenchmarkFrame[];
  label: string;
  source: ContextSource;
  initialIndex: number;
  initialReference: boolean;
  onClose: () => void;
}

export default function BenchmarkContextGallery({
  site,
  frames,
  label,
  source,
  initialIndex,
  initialReference,
  onClose,
}: BenchmarkContextGalleryProps) {
  const [index, setIndex] = useState(initialIndex);
  const [reference, setReference] = useState(initialReference);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const focus = useRef<HTMLDivElement>(null);
  const frame = frames[index];
  const clamp = (value: number, zoom: number) =>
    Math.max(-(zoom - 1) / 2, Math.min((zoom - 1) / 2, value));
  const zoomTo = (zoom: number) =>
    setView((current) => ({
      zoom,
      x: clamp(current.x, zoom),
      y: clamp(current.y, zoom),
    }));
  const move = (step: number) =>
    setIndex((current) =>
      Math.max(0, Math.min(frames.length - 1, current + step)),
    );
  const images = [
    {
      title: "Drone RGB",
      displayDate: site.droneDate
        ? benchmarkDate(site.droneDate)
        : "Acquisition date NA",
      image: site.drone,
      polygons: site.referencePolygons,
      attribution: undefined,
    },
    {
      title: label,
      displayDate:
        frame.displayDate ||
        (frame.date ? benchmarkDate(frame.date) : "Date NA"),
      image: frame.image,
      polygons: frame.referencePolygons || site.referencePolygons,
      attribution: contextAttribution(frame, source),
    },
  ];

  return (
    <Modal
      rootClassName="ph-no-capture"
      open
      onCancel={onClose}
      footer={null}
      centered
      width="min(1400px, 96vw)"
      title={`${site.country} · Drone and ${label} comparison`}
      afterOpenChange={(open) => {
        if (open) focus.current?.focus();
      }}
    >
      <div
        className="db-context-gallery"
        ref={focus}
        tabIndex={0}
        aria-label="Image comparison. Left and right arrows change the context date. Shift and arrow keys pan both images."
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          if (event.shiftKey && event.key.startsWith("Arrow")) {
            event.preventDefault();
            const dx =
              event.key === "ArrowLeft"
                ? 0.1
                : event.key === "ArrowRight"
                  ? -0.1
                  : 0;
            const dy =
              event.key === "ArrowUp"
                ? 0.1
                : event.key === "ArrowDown"
                  ? -0.1
                  : 0;
            setView((current) => ({
              ...current,
              x: clamp(current.x + dx, current.zoom),
              y: clamp(current.y + dy, current.zoom),
            }));
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            move(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <div className="db-context-gallery-toolbar">
          <BenchmarkPager
            position={`${index + 1} / ${frames.length}`}
            label="context image"
            canPrevious={index > 0}
            canNext={index < frames.length - 1}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
          />
          <BenchmarkZoomControl
            value={view.zoom}
            min={1}
            max={4}
            label="Linked image zoom"
            onChange={zoomTo}
          />
          <Checkbox
            checked={reference}
            onChange={(event) => setReference(event.target.checked)}
          >
            Reference polygons
          </Checkbox>
        </div>
        <div
          className="db-context-comparison"
          style={{
            maxWidth: `min(100%, calc(130vh * ${site.width / site.height} + 20px))`,
          }}
        >
          {images.map((image) => (
            <figure key={image.title}>
              <figcaption>
                <strong>{image.title}</strong>
                <span>{image.displayDate}</span>
              </figcaption>
              <BenchmarkComparisonViewport
                aspect={`${site.width} / ${site.height}`}
                image={image.image}
                alt={`${image.title}, ${image.displayDate}`}
                polygons={reference ? image.polygons : undefined}
                view={view}
                onPan={(dx, dy) =>
                  setView((current) => ({
                    ...current,
                    x: clamp(current.x + dx, current.zoom),
                    y: clamp(current.y + dy, current.zoom),
                  }))
                }
              />
              {image.title === "Drone RGB" && site.datasetUrl && (
                <a
                  className="db-imagery-credit"
                  href={site.datasetUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Source drone dataset ↗
                </a>
              )}
              {image.attribution && (
                <p className="db-imagery-credit">{image.attribution}</p>
              )}
            </figure>
          ))}
        </div>
        <p className="db-context-gallery-hint">
          Zoom and drag either image to inspect the same area in both. Use ← →
          to browse dates.
        </p>
      </div>
    </Modal>
  );
}
