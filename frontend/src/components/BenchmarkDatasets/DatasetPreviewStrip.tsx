import {
  getBenchmarkPatchImages,
  type BenchmarkDatasetSite,
} from "../../data/benchmarkDatasets";
import { GroundTruthMask } from "./GroundTruthMask";

const DEFAULT_PREVIEW_SITE_IDS = [375, 1396, 5584];

const pickPreviewSites = (
  sites: BenchmarkDatasetSite[],
  preferredIds: number[],
  count: number,
): BenchmarkDatasetSite[] => {
  const byId = new Map(sites.map((site) => [site.id, site]));
  const preferred = preferredIds
    .map((id) => byId.get(id))
    .filter((site): site is BenchmarkDatasetSite => Boolean(site));
  if (preferred.length >= count) return preferred.slice(0, count);
  const rest = sites.filter((site) => !preferredIds.includes(site.id));
  return [...preferred, ...rest].slice(0, count);
};

interface DatasetPreviewStripProps {
  sites: BenchmarkDatasetSite[];
  preferredSiteIds?: number[];
  pairCount?: number;
  tileClassName?: string;
}

export function DatasetPreviewStrip({
  sites,
  preferredSiteIds = DEFAULT_PREVIEW_SITE_IDS,
  pairCount = 3,
  tileClassName = "",
}: DatasetPreviewStripProps) {
  const previewSites = pickPreviewSites(sites, preferredSiteIds, pairCount);

  return (
    <div className="grid grid-cols-2 gap-px bg-gray-200 sm:grid-cols-6">
      {previewSites.flatMap((site) => {
        const previewPatch = getBenchmarkPatchImages(site, 20, 0);

        return [
          <div
            key={`${site.id}-rgb`}
            className={`aspect-square overflow-hidden bg-gray-100 ${tileClassName}`}
          >
            <img
              src={previewPatch.rgb}
              alt={`RGB benchmark patch from site ${site.id}`}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>,
          <GroundTruthMask
            key={`${site.id}-mask`}
            forestCoverSrc={previewPatch.treeCoverMask}
            deadwoodSrc={previewPatch.mortalityMask}
            alt={`Matching ground-truth mask for site ${site.id}`}
            size={256}
            className={tileClassName}
          />,
        ];
      })}
    </div>
  );
}
