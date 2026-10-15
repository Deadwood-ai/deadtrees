import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import BenchmarkWorldMap from "../components/DisturbanceBenchmark/BenchmarkWorldMap";
import BenchmarkSitePicker from "../components/DisturbanceBenchmark/BenchmarkSitePicker";
import BenchmarkSpatialGrid from "../components/DisturbanceBenchmark/BenchmarkSpatialGrid";
import BenchmarkTemporalPanel from "../components/DisturbanceBenchmark/BenchmarkTemporalPanel";
import BenchmarkMethods from "../components/DisturbanceBenchmark/BenchmarkMethods";
import BenchmarkFeedback from "../components/DisturbanceBenchmark/BenchmarkFeedback";
import {
  benchmarkAsset,
  BENCHMARK_DATA_ROOT,
} from "../components/DisturbanceBenchmark/benchmarkData";
import type {
  IBenchmarkCatalog,
  IBenchmarkSite,
} from "../components/DisturbanceBenchmark/types";
import "../components/DisturbanceBenchmark/Benchmark.css";

async function loadBenchmark<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("The benchmark data could not be loaded.");
  return response.json() as Promise<T>;
}
export default function DisturbanceBenchmarkRelease() {
  const [searchParams, setSearchParams] = useSearchParams();
  const catalog = useQuery({
    queryKey: ["disturbance-benchmark", "catalog"],
    queryFn: ({ signal }) =>
      loadBenchmark<IBenchmarkCatalog>(
        `${BENCHMARK_DATA_ROOT}/catalog.json`,
        signal,
      ),
    staleTime: 300000,
  });
  const entries = catalog.data?.sites || [];
  const requested = searchParams.get("site");
  const selected =
    entries.find((site) => site.id === requested) ||
    entries.find((site) => site.id === "Flooding_NewZeland_2024") ||
    entries[0];
  const detail = useQuery({
    queryKey: ["disturbance-benchmark", "site", selected?.id],
    queryFn: ({ signal }) =>
      loadBenchmark<IBenchmarkSite>(benchmarkAsset(selected!.detail), signal),
    enabled: Boolean(selected),
    staleTime: 300000,
  });
  const selectSite = (id: string) => {
    const query = new URLSearchParams(searchParams);
    query.set("site", id);
    setSearchParams(query, { replace: true });
  };
  return (
    <main className="db-page" data-testid="release-detail-page">
      <div className="db-page-inner">
        <Link className="db-back-link" to="/releases">
          ← All releases
        </Link>
        <section className="db-hero">
          <div className="db-hero-copy">
            <h1>
              Forest disturbance
              <br />
              <em>benchmark dataset</em>
            </h1>
            <p>
              A drone-based reference dataset for comparing large-scale forest
              disturbance products across the globe. Open drone imagery is
              linked to its source submissions; reuse follows the{" "}
              <a
                href="https://deadtrees.earth/terms-of-service"
                target="_blank"
                rel="noreferrer"
              >
                platform’s dataset licensing terms
              </a>
              .
            </p>
            <p className="db-project-credit">
              Initiated through{" "}
              <a
                href="https://climate.esa.int/en/supporting-the-paris-agreement/FORTRACK/"
                target="_blank"
                rel="noreferrer"
              >
                FORTRACK
              </a>{" "}
              within ESA’s Climate Change Initiative.
            </p>
          </div>
          {entries.length > 0 ? (
            <BenchmarkWorldMap
              sites={entries}
              selected={selected?.id || ""}
              onSelect={selectSite}
            />
          ) : (
            <div className="db-map-placeholder">
              {catalog.isError
                ? "Reference map unavailable"
                : "Loading reference landscapes…"}
            </div>
          )}
        </section>
        {catalog.isError ? (
          <div className="db-load-state" role="alert">
            <h2>Benchmark data unavailable</h2>
            <p>{catalog.error.message}</p>
            <button onClick={() => void catalog.refetch()}>Try again</button>
          </div>
        ) : (
          <>
            <div
              className="db-explorer-heading db-section-heading"
              id="db-reference-sites"
            >
              <h2>Spatial comparison with drone references</h2>
            </div>
            <div className="db-explorer">
              <BenchmarkSitePicker
                sites={entries}
                selected={selected?.id || ""}
                onSelect={selectSite}
              />
              {detail.isError ? (
                <div className="db-load-state" role="alert">
                  <h2>Site data unavailable</h2>
                  <p>{detail.error.message}</p>
                  <button onClick={() => void detail.refetch()}>
                    Try again
                  </button>
                </div>
              ) : detail.data ? (
                <BenchmarkSpatialGrid
                  key={detail.data.id}
                  site={detail.data}
                  products={catalog.data?.products || []}
                />
              ) : (
                <div className="db-load-state" aria-live="polite">
                  Loading the selected landscape…
                </div>
              )}
            </div>
            {detail.data && (
              <>
                <BenchmarkTemporalPanel
                  key={detail.data.id}
                  site={detail.data}
                />
                <BenchmarkMethods
                  site={detail.data}
                  products={catalog.data?.products || []}
                />
                <BenchmarkFeedback
                  key={`feedback-${detail.data.id}`}
                  site={detail.data}
                />
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
