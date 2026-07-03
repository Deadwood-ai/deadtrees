import { Button, Tag } from "antd";
import { DatabaseOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";

import {
  dteAerialRelease,
  droneMappingGuideRelease,
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

        <div className="mx-auto grid max-w-5xl gap-8">
          <article className="overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/5">
            <Link
              to={`/releases/${droneMappingGuideRelease.slug}`}
              onClick={trackCta(
                "home_open_drone_mapping_guide_release",
                `/releases/${droneMappingGuideRelease.slug}`,
              )}
              className="group block border-b border-gray-100 bg-white px-4 pt-4 md:px-6 md:pt-6"
              aria-label="Open the drone mapping guide"
            >
              <img
                src={droneMappingGuideRelease.guide.primaryImage}
                alt="Illustrated drone mapping workflow for the contributor guide"
                loading="lazy"
                className="block w-full rounded-lg border border-gray-200 bg-white transition-transform duration-300 group-hover:scale-[1.01]"
              />
            </Link>

            <div className="flex flex-col items-start justify-between gap-6 px-6 pt-3 pb-6 md:flex-row md:items-center md:px-8 md:pt-4 md:pb-8">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag className="m-0">{droneMappingGuideRelease.shortName}</Tag>
                </div>
                <h3 className="m-0 mt-3 text-2xl font-semibold text-gray-900">
                  {droneMappingGuideRelease.name}
                </h3>
                <p className="mt-2 max-w-3xl text-base text-gray-600">
                  {droneMappingGuideRelease.summary}
                </p>
              </div>

              <Link
                to={`/releases/${droneMappingGuideRelease.slug}`}
                onClick={trackCta(
                  "home_open_drone_mapping_guide_release_link",
                  `/releases/${droneMappingGuideRelease.slug}`,
                )}
                className="inline-flex flex-shrink-0 items-center gap-1.5 text-sm font-semibold text-[#1B5E35] hover:underline"
              >
                Open guide
                <ArrowRightOutlined />
              </Link>
            </div>
          </article>

          <article className="overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-black/5">
            <Link
              to={`/releases/${dteAerialRelease.slug}`}
              onClick={trackCta(
                "home_release_preview_strip",
                `/releases/${dteAerialRelease.slug}`,
              )}
              className="group block overflow-hidden"
              aria-label="Open the DTE-aerial-bench release"
            >
              <ReleasePreviewStrip
                tiles={getReleasePreviewTiles(dteAerialRelease)}
                tileClassName="transition-transform duration-300 group-hover:scale-[1.02]"
              />
            </Link>

            <div className="flex flex-col items-start justify-between gap-6 p-6 md:flex-row md:items-center md:p-8">
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
                <h3 className="m-0 mt-3 text-2xl font-semibold text-gray-900">
                  {dteAerialRelease.name}
                </h3>
                <p className="mt-2 max-w-3xl text-base text-gray-600">
                  A multi-resolution aerial benchmark for tree cover and mortality
                  segmentation with alternating RGB patches and paired masks.
                </p>
              </div>

              <Link
                to={`/releases/${dteAerialRelease.slug}`}
                onClick={trackCta(
                  "home_open_dte_aerial_bench_release",
                  `/releases/${dteAerialRelease.slug}`,
                )}
                className="inline-flex flex-shrink-0 items-center gap-1.5 text-sm font-semibold text-[#1B5E35] hover:underline"
              >
                Open DTE-aerial-bench
                <ArrowRightOutlined />
              </Link>
            </div>
          </article>

          <div className="flex justify-center">
            <Link to="/releases">
              <Button
                type="primary"
                size="large"
                icon={<DatabaseOutlined />}
                className="min-h-11 px-6"
                onClick={trackCta("home_browse_releases", "/releases")}
              >
                Browse Releases
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ReleasesSection;
