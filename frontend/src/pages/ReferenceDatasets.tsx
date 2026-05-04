import { DatabaseOutlined } from "@ant-design/icons";
import { Button, Tag } from "antd";
import { useNavigate } from "react-router-dom";

import {
  getReferencePatchImages,
  referenceDatasetCollections,
  type ReferenceDatasetCollection,
  type ReferenceDatasetSite,
} from "../data/referenceDatasets";
import { GroundTruthMask } from "../components/ReferenceDatasets/GroundTruthMask";

const FEATURED_PREVIEW_SITE_IDS = [375, 435, 1396, 4087, 5584, 6445];

type PreviewMode = "rgb" | "mask";

const PREVIEW_MODES: PreviewMode[] = ["rgb", "mask", "rgb", "mask", "rgb", "mask"];

const pickPreviewSites = (
  sites: ReferenceDatasetSite[],
  preferredIds: number[],
  count: number,
): ReferenceDatasetSite[] => {
  const byId = new Map(sites.map((site) => [site.id, site]));
  const preferred = preferredIds
    .map((id) => byId.get(id))
    .filter((site): site is ReferenceDatasetSite => Boolean(site));
  if (preferred.length >= count) return preferred.slice(0, count);
  const rest = sites.filter((site) => !preferredIds.includes(site.id));
  return [...preferred, ...rest].slice(0, count);
};

function FeaturedCollectionCard({
  collection,
  onOpen,
}: {
  collection: ReferenceDatasetCollection;
  onOpen: () => void;
}) {
  const previewSites = pickPreviewSites(
    collection.sites,
    FEATURED_PREVIEW_SITE_IDS,
    6,
  );
  const isAvailable = collection.status === "available";

  return (
    <article className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className="grid grid-cols-3 gap-px bg-gray-200 sm:grid-cols-6">
        {previewSites.map((site, index) => {
          const previewPatch = getReferencePatchImages(site, 20, 0);
          const mode = PREVIEW_MODES[index % PREVIEW_MODES.length];
          if (mode === "mask") {
            return (
              <GroundTruthMask
                key={site.id}
                forestCoverSrc={previewPatch.treeCoverMask}
                deadwoodSrc={previewPatch.mortalityMask}
                alt={`Reference mask from site ${site.id}`}
                size={256}
              />
            );
          }
          return (
            <div key={site.id} className="aspect-square bg-gray-100">
              <img
                src={previewPatch.rgb}
                alt={`Benchmark patch from site ${site.id}`}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
          );
        })}
      </div>

      <div className="grid gap-8 p-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:p-10">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={isAvailable ? "green" : "default"} className="m-0">
              {isAvailable ? "Available" : "Coming soon"}
            </Tag>
            <Tag className="m-0">{collection.shortName}</Tag>
            {isAvailable && <Tag className="m-0">Static v1</Tag>}
          </div>

          <h2 className="m-0 mt-5 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
            {collection.name}
          </h2>
          <p className="mt-4 text-base leading-7 text-gray-600">
            {collection.summary}
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
              Open DTE-aerial-bench
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 self-start sm:grid-cols-2">
          {collection.stats.map((stat) => (
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

export default function ReferenceDatasets() {
  const navigate = useNavigate();
  const featured = referenceDatasetCollections;

  return (
    <main className="min-h-screen bg-[#f8faf9] pt-24 md:pt-32">
      <section className="border-b border-gray-200/80 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center md:px-8 md:py-24">
          <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
            Reference datasets
          </p>
          <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
            Curated benchmark datasets from deadtrees.earth
          </h1>
          <p className="mx-auto mt-6 max-w-3xl text-lg leading-8 text-gray-600">
            Stable dataset releases with gallery views, benchmark splits, reference masks,
            metadata, and citation material for scientific reuse.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 md:px-8 md:py-16">
        <div className="grid gap-6">
          {featured.map((collection) => (
            <FeaturedCollectionCard
              key={collection.slug}
              collection={collection}
              onOpen={() =>
                navigate(`/reference-datasets/${collection.slug}`)
              }
            />
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-dashed border-gray-300 bg-white/60 px-6 py-8 text-center md:px-10">
          <span className="inline-flex items-center rounded-full bg-[#E8F3EB] px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#1B5E35]">
            More coming
          </span>
          <h3 className="m-0 mt-4 text-lg font-semibold text-gray-900 md:text-xl">
            Additional reference releases are in preparation
          </h3>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-gray-600">
            New benchmark collections — including satellite-derived products and
            extended aerial sites — will appear here as they are finalised. If
            you have a dataset to contribute,{" "}
            <a
              href="mailto:info@deadtrees.earth?subject=Reference dataset contribution"
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
