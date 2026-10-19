import { ArrowLeftOutlined, LockOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, Tag } from "antd";
import { SectionLoadError } from "../components/SectionStates";
import { useNavigate, useSearchParams } from "react-router-dom";
import BenchmarkWorldMap from "../components/DisturbanceBenchmark/BenchmarkWorldMap";
import BenchmarkSitePicker from "../components/DisturbanceBenchmark/BenchmarkSitePicker";
import BenchmarkSpatialGrid from "../components/DisturbanceBenchmark/BenchmarkSpatialGrid";
import BenchmarkTemporalPanel from "../components/DisturbanceBenchmark/BenchmarkTemporalPanel";
import BenchmarkMethods from "../components/DisturbanceBenchmark/BenchmarkMethods";
import { useBenchmarkAsset } from "../components/DisturbanceBenchmark/BenchmarkAccess";
import type {
  IBenchmarkCatalog,
  IBenchmarkSite,
} from "../components/DisturbanceBenchmark/types";
import "../components/DisturbanceBenchmark/Benchmark.css";

const DEFAULT_SITE = "Flooding_NewZeland_2024";

async function loadBenchmark<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("The benchmark data could not be loaded.");
  return response.json() as Promise<T>;
}

export default function DisturbanceBenchmarkRelease() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const benchmarkAsset = useBenchmarkAsset();
  const catalog = useQuery({
    queryKey: ["disturbance-benchmark", "catalog"],
    queryFn: ({ signal }) =>
      loadBenchmark<IBenchmarkCatalog>(benchmarkAsset("catalog.json"), signal),
    staleTime: Infinity,
  });
  const entries = catalog.data?.sites || [];
  const products = catalog.data?.products || [];
  const requested = searchParams.get("site");
  const selected =
    entries.find((site) => site.id === requested) ||
    entries.find((site) => site.id === DEFAULT_SITE) ||
    entries[0];
  const detail = useQuery({
    queryKey: ["disturbance-benchmark", "site", selected?.id],
    queryFn: ({ signal }) =>
      loadBenchmark<IBenchmarkSite>(benchmarkAsset(selected!.detail), signal),
    enabled: Boolean(selected),
    staleTime: Infinity,
  });
  const selectSite = (id: string) => {
    const query = new URLSearchParams(searchParams);
    query.set("site", id);
    setSearchParams(query, { replace: true });
  };
  const stats = [
    { label: "Sites", value: entries.length },
    {
      label: "Countries",
      value: new Set(entries.map((site) => site.country)).size,
    },
    { label: "Products", value: products.length },
  ];

  // ph-no-capture: session replay records image URLs, which carry signed
  // benchmark links; the page and its modals are left out of recordings.
  return (
    <main
      className="ph-no-capture min-h-screen bg-[#f8faf9] pt-24 md:pt-32"
      data-testid="release-detail-page"
    >
      <section className="border-b border-gray-200/80 bg-white">
        <div className="mx-auto max-w-7xl px-4 pt-8 md:px-8">
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate("/releases")}
            type="text"
            className="px-0"
          >
            Back to releases
          </Button>
        </div>
        <div className="mx-auto grid max-w-7xl gap-10 px-4 pb-16 pt-8 md:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)] md:gap-12 md:px-8 md:pb-20">
          <div>
            <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
              Benchmark dataset · Forest disturbance
            </p>
            <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
              Forest disturbance benchmark
            </h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-600">
              Drone reference maps for comparing large-scale forest disturbance
              products across the globe, with satellite time series and dated
              imagery around each flight.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Tag icon={<LockOutlined />} className="m-0">
                Core team only
              </Tag>
              <span className="text-sm text-gray-500">
                Initiated through{" "}
                <a
                  href="https://climate.esa.int/en/supporting-the-paris-agreement/FORTRACK/"
                  target="_blank"
                  rel="noreferrer"
                >
                  FORTRACK
                </a>{" "}
                within ESA’s Climate Change Initiative.
              </span>
            </div>
            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-lg border border-gray-200 bg-white p-4"
                >
                  <div className="text-2xl font-semibold text-[#1B5E35]">
                    {catalog.data ? stat.value : "–"}
                  </div>
                  <div className="mt-1 text-xs font-semibold uppercase text-gray-500">
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {entries.length > 0 ? (
            <BenchmarkWorldMap
              sites={entries}
              selected={selected?.id || ""}
              onSelect={selectSite}
            />
          ) : (
            <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-gray-200 bg-gray-50 text-sm text-gray-500">
              {catalog.isError ? "Site map unavailable" : "Loading sites…"}
            </div>
          )}
        </div>
      </section>

      <div className="db-page mx-auto max-w-7xl space-y-12 px-4 py-10 md:px-8 md:py-14">
        {catalog.isError ? (
          <SectionLoadError
            title="Benchmark data unavailable"
            onRetry={() => void catalog.refetch()}
          />
        ) : (
          <>
            <section aria-labelledby="db-reference-sites">
              <div className="db-section-heading">
                <h2 id="db-reference-sites">
                  Spatial comparison with drone references
                </h2>
                <p>
                  Pick a site to compare the drone reference with each product's
                  saved prediction for the preceding and flight year.
                </p>
              </div>
              <div className="db-explorer">
                <BenchmarkSitePicker
                  sites={entries}
                  selected={selected?.id || ""}
                  onSelect={selectSite}
                />
                {detail.isError ? (
                  <SectionLoadError
                    title="Site data unavailable"
                    onRetry={() => void detail.refetch()}
                  />
                ) : detail.data ? (
                  <BenchmarkSpatialGrid
                    key={detail.data.id}
                    site={detail.data}
                    products={products}
                  />
                ) : (
                  <Skeleton active paragraph={{ rows: 8 }} />
                )}
              </div>
            </section>
            {detail.data && (
              <>
                <BenchmarkTemporalPanel
                  key={detail.data.id}
                  site={detail.data}
                />
                <BenchmarkMethods site={detail.data} products={products} />
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
