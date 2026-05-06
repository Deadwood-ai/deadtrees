import type { IPrepackagedDatasetPackage } from "../api/prepackaged";
import {
  dteAerialRelease,
  getDteAerialPatchImages,
  type DteAerialSite,
  type ReleasePreviewTile,
} from "../data/releases";

const dteAerialSiteById = new Map(
  dteAerialRelease.dteAerial.sites.map((site) => [site.id, site]),
);

const previewSiteIdsByPackage: Record<string, number[]> = {
  "tree-cover-aerial-global": [375, 1396, 5584, 3251, 4010, 5463],
  "standing-deadwood-aerial-global-conservative": [
    435, 3341, 3834, 400, 5756, 5931,
  ],
  "image-tiles-1024-global-aerial-sampled-20-random": [
    400, 4010, 4087, 4471, 5756, 6445,
  ],
};

function getPreviewSites(datasetPackage: IPrepackagedDatasetPackage) {
  const ids =
    previewSiteIdsByPackage[datasetPackage.slug] ??
    previewSiteIdsByPackage["tree-cover-aerial-global"];

  return ids
    .map((id) => dteAerialSiteById.get(id))
    .filter((site): site is DteAerialSite => Boolean(site));
}

export function getPrepackagedDatasetPreviewTiles(
  datasetPackage: IPrepackagedDatasetPackage,
): ReleasePreviewTile[] {
  const sites = getPreviewSites(datasetPackage);

  if (datasetPackage.kind === "tiles") {
    return sites.map((site) => {
      const previewPatch = getDteAerialPatchImages(site, 20, 0);
      return {
        kind: "image" as const,
        key: `${datasetPackage.slug}-${site.id}-rgb`,
        src: previewPatch.rgb,
        alt: `Aerial image tile preview from dataset ${site.id}`,
      };
    });
  }

  if (datasetPackage.slug === "tree-cover-aerial-global") {
    return sites.map((site) => {
      const previewPatch = getDteAerialPatchImages(site, 20, 0);
      return {
        kind: "single-mask" as const,
        key: `${datasetPackage.slug}-${site.id}-tree-cover`,
        src: previewPatch.treeCoverMask,
        layer: "tree-cover" as const,
        alt: `Tree-cover geometry preview from dataset ${site.id}`,
      };
    });
  }

  if (datasetPackage.slug === "standing-deadwood-aerial-global-conservative") {
    return sites.map((site) => {
      const previewPatch = getDteAerialPatchImages(site, 20, 0);
      return {
        kind: "single-mask" as const,
        key: `${datasetPackage.slug}-${site.id}-deadwood`,
        src: previewPatch.mortalityMask,
        layer: "deadwood" as const,
        alt: `Standing-deadwood geometry preview from dataset ${site.id}`,
      };
    });
  }

  return sites.map((site) => {
    const previewPatch = getDteAerialPatchImages(site, 20, 0);
    return {
      kind: "single-mask" as const,
      key: `${datasetPackage.slug}-${site.id}-tree-cover`,
      src: previewPatch.treeCoverMask,
      layer: "tree-cover" as const,
      alt: `Data package geometry preview from dataset ${site.id}`,
    };
  });
}

export function getPrepackagedDatasetVisualSummary(
  datasetPackage: IPrepackagedDatasetPackage,
) {
  switch (datasetPackage.slug) {
    case "tree-cover-aerial-global":
      return {
        eyebrow: "Audited tree-cover geometry",
        note: "Previewing only the tree-cover class layer represented in this vector package.",
      };
    case "standing-deadwood-aerial-global-conservative":
      return {
        eyebrow: "Conservative standing-deadwood geometry",
        note: "Previewing only the standing-deadwood class layer represented in this vector package.",
      };
    case "image-tiles-1024-global-aerial-sampled-20-random":
      return {
        eyebrow: "Sampled source-resolution imagery",
        note: "Previewing only representative aerial image tiles from the imagery package.",
      };
    default:
      return {
        eyebrow: "Versioned data package",
        note: "Previewing representative source datasets from the release.",
      };
  }
}
