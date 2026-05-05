import { DatabaseOutlined } from "@ant-design/icons";
import { Button, Tag } from "antd";
import { useNavigate } from "react-router-dom";

import {
  publicReleases,
  getReleasePreviewTiles,
  getReleaseStats,
  type PublicRelease,
} from "../data/releases";
import { ReleasePreviewStrip } from "../components/Releases/ReleasePreviewStrip";

function FeaturedReleaseCard({
  release,
  onOpen,
}: {
  release: PublicRelease;
  onOpen: () => void;
}) {
  const isAvailable = release.status === "available";
  const stats = getReleaseStats(release);

  return (
    <article className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <ReleasePreviewStrip tiles={getReleasePreviewTiles(release)} />

      <div className="grid gap-8 p-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:p-10">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={isAvailable ? "green" : "default"} className="m-0">
              {isAvailable ? "Available" : "Coming soon"}
            </Tag>
            <Tag className="m-0">{release.typeLabel}</Tag>
            <Tag className="m-0">{release.shortName}</Tag>
          </div>

          <h2 className="m-0 mt-5 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
            {release.name}
          </h2>
          <p className="mt-4 text-base leading-7 text-gray-600">
            {release.summary}
          </p>

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

        <div className="grid grid-cols-2 gap-3 self-start sm:grid-cols-2">
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

export default function Releases() {
  const navigate = useNavigate();

  return (
    <main className="min-h-screen bg-[#f8faf9] pt-24 md:pt-32">
      <section className="border-b border-gray-200/80 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center md:px-8 md:py-24">
          <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
            Releases
          </p>
          <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
            Published resources from deadtrees.earth
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg leading-8 text-gray-600">
            Stable data, model, and benchmark releases with metadata and
            previews for scientific reuse.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 md:px-8 md:py-16">
        <div className="grid gap-6">
          {publicReleases.map((release) => (
            <FeaturedReleaseCard
              key={release.slug}
              release={release}
              onOpen={() => navigate(`/releases/${release.slug}`)}
            />
          ))}
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
