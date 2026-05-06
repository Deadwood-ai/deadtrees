import {
  ArrowLeftOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { Button, Tag } from "antd";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { DteAerialReleaseGallery } from "../components/Releases/DteAerialReleaseGallery";
import { DteAerialReleaseSiteMap } from "../components/Releases/DteAerialReleaseSiteMap";
import {
  getReleaseStats,
  getCoarseBiomeGroup,
  type DteAerialRelease as DteAerialReleaseData,
} from "../data/releases";
import { useDteAerialDatasetAdminInfo } from "../hooks/useDteAerialDatasetAdminInfo";

interface DteAerialReleaseProps {
  release: DteAerialReleaseData;
}

export default function DteAerialRelease({ release }: DteAerialReleaseProps) {
  const navigate = useNavigate();
  const benchmark = release.dteAerial;
  const { adminInfoByDatasetId, isAdminInfoLoading } =
    useDteAerialDatasetAdminInfo(release);
  const heroTagline = release.title.startsWith(`${release.name}: `)
    ? release.title.slice(release.name.length + 2)
    : release.title;

  const releaseStats = useMemo(() => getReleaseStats(release), [release]);

  const biomeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    benchmark.sites.forEach((site) => {
      const biomeGroup = getCoarseBiomeGroup(site.biome);
      counts.set(biomeGroup, (counts.get(biomeGroup) ?? 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [benchmark.sites]);

  return (
    <main
      className="min-h-screen bg-[#f8faf9] pt-24 md:pt-32"
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

        <div className="mx-auto grid max-w-7xl gap-10 px-4 pb-16 pt-8 md:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] md:gap-12 md:px-8 md:pb-24">
          <div>
            <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
              {release.typeLabel} · {release.shortName}
            </p>
            <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
              {release.name}
            </h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-600">
              {heroTagline}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                type="primary"
                size="large"
                icon={<DownloadOutlined />}
                disabled
                className="min-h-11"
              >
                Download dataset
              </Button>
              <Tag className="m-0" color="warning">
                Coming soon
              </Tag>
            </div>
          </div>

          <DteAerialReleaseSiteMap sites={benchmark.sites} />
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-10 md:px-8 md:py-12">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
            {releaseStats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-gray-200 bg-white p-5"
              >
                <div className="text-2xl font-semibold text-[#1B5E35]">
                  {stat.value}
                </div>
                <div className="mt-1 text-xs font-semibold uppercase text-gray-500">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <GlobalOutlined />
              Coverage across biome groups
            </div>
            <div className="mt-4 space-y-2.5">
              {biomeCounts.map(([biome, count]) => (
                <div
                  key={biome}
                  className="grid grid-cols-[140px_minmax(0,1fr)_28px] items-center gap-3"
                >
                  <span
                    className="truncate text-[13px] font-medium text-gray-700"
                    title={biome}
                  >
                    {biome}
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                    <span
                      className="block h-full rounded-full bg-[#1B5E35]"
                      style={{
                        width: `${(count / benchmark.sites.length) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="text-right text-[13px] font-semibold tabular-nums text-gray-800">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <DteAerialReleaseGallery
        release={release}
        adminInfoByDatasetId={adminInfoByDatasetId}
        isAdminInfoLoading={isAdminInfoLoading}
      />

      <section
        id="dataset-download-placeholder"
        className="border-t border-gray-200 bg-white"
      >
        <div className="mx-auto max-w-7xl px-4 py-16 md:px-8 md:py-20">
          <div className="max-w-3xl">
            <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35]">
              Release artifacts
            </p>
            <h2 className="m-0 mt-3 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
              Dataset package
            </h2>
            <p className="mt-3 text-base leading-7 text-gray-600">
              The gallery above is the live preview of the dataset. The download
              button is disabled until the Hugging Face package is available.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                type="primary"
                size="large"
                icon={<DatabaseOutlined />}
                disabled
                className="min-h-11"
              >
                Download dataset
              </Button>
              <Tag className="m-0" color="warning">
                Coming soon
              </Tag>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
