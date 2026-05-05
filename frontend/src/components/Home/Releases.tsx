import { Button, Tag } from "antd";
import { DatabaseOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";

import {
  dteAerialRelease,
  getReleasePreviewTiles,
  getReleaseTeaserMeta,
} from "../../data/releases";
import { ReleasePreviewStrip } from "../Releases/ReleasePreviewStrip";
import { useAnalytics } from "../../hooks/useAnalytics";

const ReleasesSection = () => {
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
            Releases
          </p>
          <h2 className="m-0 text-4xl font-semibold text-gray-800 md:text-5xl">
            Published resources for forest AI
          </h2>
          <p className="mx-auto mt-6 max-w-3xl text-lg text-gray-600">
            Stable, citable datasets, models, and benchmarks built for
            reproducible machine learning research on tree cover and standing
            deadwood.
          </p>
        </div>

        <div className="mx-auto max-w-5xl">
          <Link
            to={`/releases/${dteAerialRelease.slug}`}
            onClick={trackCta(
              "home_release_preview_strip",
              `/releases/${dteAerialRelease.slug}`,
            )}
            className="group block overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5 transition-all hover:shadow-2xl"
            aria-label="Open the DTE-aerial-bench release"
          >
            <ReleasePreviewStrip
              tiles={getReleasePreviewTiles(dteAerialRelease)}
              tileClassName="transition-transform duration-300 group-hover:scale-[1.02]"
            />
          </Link>

          <div className="mt-8 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Tag color="green" className="m-0">
                  Available
                </Tag>
                <Tag className="m-0">{dteAerialRelease.typeLabel}</Tag>
                <span className="text-sm font-semibold text-gray-700">
                  {dteAerialRelease.shortName}
                </span>
                <span aria-hidden className="text-gray-300">
                  -
                </span>
                <span className="text-sm text-gray-500">
                  {getReleaseTeaserMeta(dteAerialRelease)}
                </span>
              </div>
              <p className="mt-2 text-base text-gray-600">
                A multi-resolution aerial benchmark for tree cover and mortality
                segmentation with alternating RGB patches and paired masks.
              </p>
            </div>

            <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
              <Link to="/releases">
                <Button
                  type="primary"
                  size="large"
                  icon={<DatabaseOutlined />}
                  className="min-h-11 px-6"
                  onClick={trackCta(
                    "home_browse_releases",
                    "/releases",
                  )}
                >
                  Browse Releases
                </Button>
              </Link>
              <Link
                to={`/releases/${dteAerialRelease.slug}`}
                onClick={trackCta(
                  "home_open_dte_aerial_bench_release",
                  `/releases/${dteAerialRelease.slug}`,
                )}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#1B5E35] hover:underline"
              >
                Open DTE-aerial-bench
                <ArrowRightOutlined />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ReleasesSection;
