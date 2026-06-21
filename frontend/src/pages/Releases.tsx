import { DatabaseOutlined } from "@ant-design/icons";
import { Alert, Button, Skeleton, Tag } from "antd";
import { useNavigate } from "react-router-dom";

import type { IPrepackagedDatasetPackage } from "../api/prepackaged";
import {
  publicReleases,
  getReleasePreviewTiles,
  getReleaseStats,
  type ReleaseStat,
  type ReleasePreviewTile,
} from "../data/releases";
import { ReleasePreviewStrip } from "../components/Releases/ReleasePreviewStrip";
import { usePrepackagedDatasets } from "../hooks/usePrepackagedDatasets";
import { getPrepackagedDatasetPreviewTiles } from "../utils/prepackagedDatasetPreviews";
import {
  formatPrepackagedBytes,
  formatPrepackagedDate,
  getLatestPrepackagedVersion,
  prepackagedNumberFormatter,
} from "../utils/prepackagedDatasets";

function ReleaseCard({
  previewTiles,
  isAvailable,
  typeLabel,
  shortName,
  title,
  summary,
  stats,
  onOpen,
}: {
  previewTiles: ReleasePreviewTile[];
  isAvailable: boolean;
  typeLabel: string;
  shortName: string;
  title: string;
  summary: string;
  stats: ReleaseStat[];
  onOpen: () => void;
}) {
  return (
    <article
      className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md"
      data-testid="release-card"
    >
      <ReleasePreviewStrip tiles={previewTiles} />

      <div className="grid gap-8 p-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:p-10">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={isAvailable ? "green" : "default"} className="m-0">
              {isAvailable ? "Available" : "Coming soon"}
            </Tag>
            <Tag className="m-0">{typeLabel}</Tag>
            <Tag className="m-0">{shortName}</Tag>
          </div>

          <h2 className="m-0 mt-5 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
            {title}
          </h2>
          <p className="mt-4 text-base leading-7 text-gray-600">{summary}</p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button
              type="primary"
              size="large"
              icon={<DatabaseOutlined />}
              onClick={onOpen}
              className="min-h-11"
              disabled={!isAvailable}
            >
              Open release
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 self-start">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-gray-100 bg-gray-50 p-4"
            >
              <div className="text-2xl font-semibold text-[#1B5E35]">
                {stat.value}
              </div>
              <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function buildPrepackagedStats(pkg: IPrepackagedDatasetPackage): ReleaseStat[] {
  const v = getLatestPrepackagedVersion(pkg);
  if (!v) return [];
  return [
    { label: "Package size", value: formatPrepackagedBytes(v.size_bytes) },
    {
      label: "Datasets",
      value:
        v.dataset_count === null
          ? "Unknown"
          : prepackagedNumberFormatter.format(v.dataset_count),
    },
    { label: "Built", value: formatPrepackagedDate(v.built_at) },
  ];
}

export default function Releases() {
  const navigate = useNavigate();
  const { data: dataPackages, isLoading, error } = usePrepackagedDatasets();
  const availableDataPackages =
    dataPackages
      ?.filter((pkg) => pkg.versions.length > 0)
      .sort((a, b) => a.sort_order - b.sort_order) ?? [];

  return (
    <main
      className="min-h-screen bg-[#f8faf9] pt-24 md:pt-32"
      data-testid="releases-page"
    >
      <section className="border-b border-gray-200/80 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center md:px-8 md:py-24">
          <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
            Releases
          </p>
          <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
            Published resources from deadtrees.earth
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg leading-8 text-gray-600">
            Stable datasets and benchmarks with metadata and previews for
            scientific reuse—including versioned ZIP packages sourced from
            public CC BY data.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 md:px-8 md:py-16">
        <div className="grid gap-6">
          {publicReleases.map((release) => (
            <ReleaseCard
              key={release.slug}
              previewTiles={getReleasePreviewTiles(release)}
              isAvailable={release.status === "available"}
              typeLabel={release.typeLabel}
              shortName={release.shortName}
              title={release.name}
              summary={release.summary}
              stats={getReleaseStats(release)}
              onOpen={() => navigate(`/releases/${release.slug}`)}
            />
          ))}

          {isLoading && (
            <Skeleton active paragraph={{ rows: 6 }} className="p-2" />
          )}

          {error && (
            <Alert
              type="error"
              showIcon
              message="Could not load dataset packages"
              description={error instanceof Error ? error.message : undefined}
            />
          )}

          {availableDataPackages.map((pkg) => {
            const stats = buildPrepackagedStats(pkg);
            if (!stats.length) return null;
            return (
              <ReleaseCard
                key={pkg.slug}
                previewTiles={getPrepackagedDatasetPreviewTiles(pkg)}
                isAvailable={true}
                typeLabel="Data package"
                shortName={pkg.slug}
                title={pkg.title}
                summary={pkg.summary}
                stats={stats}
                onOpen={() => navigate(`/releases/${pkg.slug}`)}
              />
            );
          })}
        </div>

        <div className="mt-10 rounded-2xl border border-dashed border-gray-300 bg-white/60 px-6 py-8 text-center md:px-10">
          <span className="inline-flex items-center rounded-full bg-[#E8F3EB] px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#1B5E35]">
            More coming
          </span>
          <h3 className="m-0 mt-4 text-lg font-semibold text-gray-900 md:text-xl">
            Additional releases are in preparation
          </h3>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-gray-600">
            New resources, including datasets, models, and benchmark
            collections, will appear here as they are finalised. If you have a
            release to contribute,{" "}
            <a
              href="mailto:info@deadtrees.earth?subject=Release contribution"
              className="font-semibold text-[#1B5E35] underline"
            >
              get in touch
            </a>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
