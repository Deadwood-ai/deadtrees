import { useRef, useState } from "react";
import { Alert, Modal } from "antd";
import BenchmarkProductHeading from "./BenchmarkProductHeading";
import BenchmarkScores from "./BenchmarkScores";
import BenchmarkLayerControl from "./BenchmarkLayerControl";
import { useBenchmarkAsset } from "./BenchmarkAccess";
import { BenchmarkPager, BenchmarkZoomControl } from "./BenchmarkControls";
import { availablePredictions, benchmarkDate } from "./benchmarkData";
import type {
  IBenchmarkProduct,
  IBenchmarkSite,
  IBenchmarkEvaluation,
} from "./types";

interface BenchmarkSpatialGridProps {
  site: IBenchmarkSite;
  products: IBenchmarkProduct[];
}
interface SpatialFrame {
  title: string;
  subtitle?: string;
  image: string;
  preview?: string;
  /** Drone RGB under a prediction overlay. */
  background?: string;
  backgroundPreview?: string;
  product?: IBenchmarkProduct;
  counts?: IBenchmarkEvaluation["counts"];
  layers?: IBenchmarkEvaluation["layers"];
  selectedLayer?: number;
}
/** Tiles load the small previews; the enlarged gallery view loads full images. */
function SpatialImage({
  frame,
  full = false,
}: {
  frame: SpatialFrame;
  full?: boolean;
}) {
  const benchmarkAsset = useBenchmarkAsset();
  const base = frame.background
    ? (!full && frame.backgroundPreview) || frame.background
    : (!full && frame.preview) || frame.image;
  return (
    <>
      <img src={benchmarkAsset(base)} alt={frame.title} loading="lazy" />
      {frame.background && (
        <img
          className="db-prediction-overlay"
          src={benchmarkAsset(frame.image)}
          alt=""
          loading="lazy"
        />
      )}
    </>
  );
}
export default function BenchmarkSpatialGrid({
  site,
  products,
}: BenchmarkSpatialGridProps) {
  const galleryImage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [active, setActive] = useState<number | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<Record<string, number>>(
    {},
  );
  const frames: SpatialFrame[] = [
    {
      title: "Drone RGB",
      subtitle: "RGB orthomosaic",
      image: site.drone,
      preview: site.dronePreview,
    },
    {
      title: "Drone reference",
      subtitle: "Binary disturbance map: tree-cover loss and standing deadwood",
      image:
        site.referenceBinary ||
        site.reference.replace("reference.png", "reference-binary.png"),
    },
    ...availablePredictions(site, products).map(({ product, evaluation }) => ({
      title: product.name,
      product,
      image:
        evaluation.layers?.[selectedLayers[product.id] || 0]?.image ||
        evaluation.prediction!,
      background: site.drone,
      backgroundPreview: site.dronePreview,
      counts: evaluation.counts,
      layers: evaluation.layers,
      selectedLayer: selectedLayers[product.id] || 0,
    })),
  ];
  const move = (step: number) =>
    setActive((current) =>
      current === null
        ? null
        : (current + step + frames.length) % frames.length,
    );
  return (
    <section className="db-spatial" aria-labelledby="db-spatial-title">
      <div className="db-selected-heading">
        <div>
          <div className="db-site-title-row">
            <h2 id="db-spatial-title">
              {site.country} ·{" "}
              {site.droneDate
                ? benchmarkDate(site.droneDate)
                : `${site.year} (year only)`}{" "}
              <span className="db-site-agent">
                (primary disturbance agent: {site.type.toLowerCase()})
              </span>
            </h2>
            {site.datasetUrl && (
              <a
                className="db-submission-link"
                href={site.datasetUrl}
                target="_blank"
                rel="noreferrer"
              >
                Drone dataset #
                {site.datasetUrl.match(/\/dataset\/(\d+)/)?.[1] || "source"} ↗
              </a>
            )}
            {site.catalogueStatus &&
              site.catalogueStatus.toLowerCase() !== "ok" && (
                <span className="db-source-status">
                  Source status: {site.catalogueStatus}
                </span>
              )}
          </div>
        </div>
        <BenchmarkZoomControl
          value={zoom}
          min={1}
          max={3}
          label="Image tile size"
          onChange={setZoom}
        />
      </div>
      {site.dataWarnings?.map((warning) => (
        <Alert
          className="mb-3"
          key={warning}
          type="warning"
          showIcon
          message={
            <>
              <strong>Data review:</strong> {warning}
            </>
          }
        />
      ))}
      <div
        className="db-spatial-grid"
        style={{ "--db-tile-zoom": zoom } as React.CSSProperties}
      >
        {frames.map((frame, index) => (
          <article className="db-preview-card" key={frame.title}>
            <div className="db-preview-heading">
              {frame.product ? (
                <BenchmarkProductHeading product={frame.product} />
              ) : (
                <>
                  <h3>{frame.title}</h3>
                </>
              )}
            </div>
            <button
              className="db-preview-image"
              style={{ aspectRatio: `${site.width} / ${site.height}` }}
              onClick={() => setActive(index)}
              aria-label={`Enlarge ${frame.title}`}
            >
              <SpatialImage frame={frame} />
            </button>
            {frame.product && frame.layers?.length ? (
              <BenchmarkLayerControl
                layers={frame.layers}
                selected={frame.selectedLayer || 0}
                onSelect={(index) =>
                  setSelectedLayers((current) => ({
                    ...current,
                    [frame.product!.id]: index,
                  }))
                }
              />
            ) : null}
            {frame.product && <BenchmarkScores counts={frame.counts} />}
            {!frame.product && (
              <div
                className="db-product-scores"
                title="Approximate area in the displayed orthomosaic footprint, calculated from the aligned preview grid; excludes no-data pixels."
              >
                <span>
                  {index === 0 ? "Total area" : "Disturbed area"}{" "}
                  <strong>
                    {(index === 0
                      ? site.displayDroneAreaHa
                      : site.displayDisturbedAreaHa
                    )?.toLocaleString("en-GB", {
                      maximumFractionDigits: 2,
                      minimumFractionDigits: 2,
                    }) ?? "NA"}{" "}
                    ha
                  </strong>
                </span>
              </div>
            )}
          </article>
        ))}
      </div>
      <Modal
        open={active !== null}
        onCancel={() => setActive(null)}
        footer={null}
        width="min(1100px, 96vw)"
        title={
          active === null
            ? ""
            : `${frames[active].title} · ${site.country} ${site.year}`
        }
        afterOpenChange={(open) => {
          if (open) galleryImage.current?.focus();
        }}
        centered
      >
        {active !== null && (
          <div
            className="db-gallery"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                move(event.key === "ArrowLeft" ? -1 : 1);
              }
            }}
          >
            <div className="db-gallery-controls">
              <BenchmarkPager
                position={`${active + 1} / ${frames.length}`}
                label="gallery image"
                canPrevious
                canNext
                onPrevious={() => move(-1)}
                onNext={() => move(1)}
              />
            </div>
            <div
              ref={galleryImage}
              className="db-gallery-image"
              style={{
                aspectRatio: `${site.width} / ${site.height}`,
                maxWidth: `min(100%, calc(70vh * ${site.width / site.height}))`,
              }}
              tabIndex={0}
              aria-label="Image gallery. Use left and right arrow keys to browse."
            >
              <SpatialImage frame={frames[active]} full />
            </div>
            <p>
              {site.width} × {site.height} pixel preview · Use ← → to browse
            </p>
          </div>
        )}
      </Modal>
    </section>
  );
}
