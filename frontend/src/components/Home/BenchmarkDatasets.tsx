import { Button, Tag } from "antd";
import { DatabaseOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";

import { dteAerialBenchmarkDataset } from "../../data/benchmarkDatasets";
import { DatasetPreviewStrip } from "../BenchmarkDatasets/DatasetPreviewStrip";
import { useAnalytics } from "../../hooks/useAnalytics";

const BenchmarkDatasetsSection = () => {
  const { track } = useAnalytics("home");

  const trackCta = (cta: string, target: string) => () =>
    track("landing_cta_clicked", {
      cta_name: cta,
      action_target: target,
    });

  return (
    <section className="w-full bg-white py-24 md:py-32">
      <div className="m-auto max-w-6xl px-4 md:px-8">
        <div className="mb-12 text-center md:mb-16">
          <p className="mb-2 text-lg font-semibold uppercase tracking-wider text-[#1B5E35]">
            Benchmark Data
          </p>
          <h2 className="m-0 text-4xl font-semibold text-gray-800 md:text-5xl">
            Curated benchmarks for forest AI
          </h2>
          <p className="mx-auto mt-6 max-w-3xl text-lg text-gray-600">
            Stable, citable releases with expert ground-truth masks,
            multi-resolution patches, and benchmark splits - built for
            reproducible machine learning research on tree cover and standing
            deadwood.
          </p>
        </div>

        <div className="mx-auto max-w-5xl">
          <Link
            to={`/benchmark-datasets/${dteAerialBenchmarkDataset.slug}`}
            onClick={trackCta(
              "home_benchmark_preview_strip",
              `/benchmark-datasets/${dteAerialBenchmarkDataset.slug}`,
            )}
            className="group block overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5 transition-all hover:shadow-2xl"
            aria-label="Open the DTE-aerial-bench benchmark gallery"
          >
            <DatasetPreviewStrip
              sites={dteAerialBenchmarkDataset.sites}
              tileClassName="transition-transform duration-300 group-hover:scale-[1.02]"
            />
          </Link>

          <div className="mt-8 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Tag color="green" className="m-0">
                  Available
                </Tag>
                <span className="text-sm font-semibold text-gray-700">
                  {dteAerialBenchmarkDataset.shortName}
                </span>
                <span aria-hidden className="text-gray-300">
                  -
                </span>
                <span className="text-sm text-gray-500">
                  25 sites - 525 patches - 5, 10, 20 cm resolutions
                </span>
              </div>
              <p className="mt-2 text-base text-gray-600">
                A multi-resolution aerial benchmark for tree cover and mortality
                segmentation - alternating RGB patches with paired ground-truth
                masks.
              </p>
            </div>

            <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
              <Link to="/benchmark-datasets">
                <Button
                  type="primary"
                  size="large"
                  icon={<DatabaseOutlined />}
                  className="min-h-11 px-6"
                  onClick={trackCta(
                    "home_browse_benchmark_data",
                    "/benchmark-datasets",
                  )}
                >
                  Browse Benchmark Data
                </Button>
              </Link>
              <Link
                to={`/benchmark-datasets/${dteAerialBenchmarkDataset.slug}`}
                onClick={trackCta(
                  "home_open_dte_aerial_bench_gallery",
                  `/benchmark-datasets/${dteAerialBenchmarkDataset.slug}`,
                )}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#1B5E35] hover:underline"
              >
                Open DTE-aerial-bench gallery
                <ArrowRightOutlined />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default BenchmarkDatasetsSection;
