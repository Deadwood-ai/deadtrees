import {
  CalendarOutlined,
  LeftOutlined,
  RightOutlined,
  SelectOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Modal, Segmented, Select, Tag, Tooltip } from "antd";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";

import {
  getBenchmarkPatchGridImages,
  getCoarseBiomeGroup,
  type BenchmarkDatasetAdminInfo,
  type BenchmarkDatasetCollection,
  type BenchmarkDatasetSite,
  type BenchmarkPatchImageSet,
  type BenchmarkPatchResolution,
} from "../../data/benchmarkDatasets";
import { GROUND_TRUTH_COLORS, GroundTruthMask } from "./GroundTruthMask";

type SortKey = "dataset" | "biome" | "west-east" | "north-south";
type GalleryResolutionFilter = "all" | "20" | "10" | "5";
type PatchViewerMode = "rgb" | "overlay" | "mask";

// One PatchCard width (190px) plus flex gap (12px).
const GALLERY_PATCH_STEP_PX = 202;

interface SelectedBenchmarkPatch {
  site: BenchmarkDatasetSite;
  patch: BenchmarkPatchImageSet;
}

const sortOptions: Array<{ label: string; value: SortKey }> = [
  { label: "Dataset ID", value: "dataset" },
  { label: "Biome", value: "biome" },
  { label: "West to east", value: "west-east" },
  { label: "North to south", value: "north-south" },
];

const galleryResolutionOptions: Array<{
  label: string;
  value: GalleryResolutionFilter;
}> = [
  { label: "All", value: "all" },
  { label: "5", value: "5" },
  { label: "10", value: "10" },
  { label: "20", value: "20" },
];

const makeThumbnailUrl = (site: BenchmarkDatasetSite) =>
  `https://data2.deadtrees.earth/thumbnails/v1/${site.thumbnailPath}`;

const normalizeMetadataValue = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed || null;
};

interface DatasetLocationLabels {
  primary: string;
  secondary: string | null;
}

const formatDatasetLocationLabels = (
  adminInfo: BenchmarkDatasetAdminInfo | undefined,
  isLoading: boolean,
): DatasetLocationLabels => {
  if (!adminInfo) {
    return {
      primary: isLoading ? "Loading metadata" : "Location unavailable",
      secondary: null,
    };
  }

  const country = normalizeMetadataValue(adminInfo.admin_level_1);
  const region = normalizeMetadataValue(adminInfo.admin_level_2);
  const locality = normalizeMetadataValue(adminInfo.admin_level_3);

  if (locality) {
    const parents = [region, country].filter(Boolean).join(", ");
    return { primary: locality, secondary: parents || null };
  }

  if (region) {
    return { primary: region, secondary: country };
  }

  if (country) {
    return { primary: country, secondary: null };
  }

  return { primary: "Location unavailable", secondary: null };
};

const formatAcquisitionDate = (
  adminInfo: BenchmarkDatasetAdminInfo | undefined,
  isLoading: boolean,
) => {
  if (!adminInfo) return isLoading ? "Loading" : "Unknown";
  if (!adminInfo.aquisition_year) return "Unknown";

  const year = Number(adminInfo.aquisition_year);
  const month = adminInfo.aquisition_month
    ? Number(adminInfo.aquisition_month)
    : undefined;
  const day = adminInfo.aquisition_day
    ? Number(adminInfo.aquisition_day)
    : undefined;

  return new Date(year, month ? month - 1 : 0, day ?? 1).toLocaleDateString(
    "en-US",
    {
      year: "numeric",
      ...(month && { month: "short" }),
      ...(day && { day: "numeric" }),
    },
  );
};

const formatPlatform = (
  platform: string | null | undefined,
  isLoading: boolean,
) => {
  const normalized = normalizeMetadataValue(platform);
  if (!normalized) return isLoading ? "Loading" : "Unknown";
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
};

const sortSites = (sites: BenchmarkDatasetSite[], sortKey: SortKey) => {
  const sorted = [...sites];

  if (sortKey === "biome") {
    return sorted.sort(
      (a, b) =>
        getCoarseBiomeGroup(a.biome).localeCompare(
          getCoarseBiomeGroup(b.biome),
        ) || a.id - b.id,
    );
  }

  if (sortKey === "west-east") {
    return sorted.sort((a, b) => a.center.lon - b.center.lon);
  }

  if (sortKey === "north-south") {
    return sorted.sort((a, b) => b.center.lat - a.center.lat);
  }

  return sorted.sort((a, b) => a.id - b.id);
};

function ImageTile({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="aspect-square overflow-hidden rounded-md bg-gray-100">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function PatchCard({
  site,
  patch,
  onSelect,
}: {
  site: BenchmarkDatasetSite;
  patch: BenchmarkPatchImageSet;
  onSelect: (selection: SelectedBenchmarkPatch) => void;
}) {
  return (
    <button
      type="button"
      data-testid="benchmark-patch-card"
      data-resolution={`${patch.resolutionCm}`}
      className="w-[190px] shrink-0 cursor-pointer rounded-lg border border-gray-200 bg-white p-3 text-left transition-colors duration-150 hover:border-[#1B5E35]/60 hover:bg-white"
      aria-label={`Dataset ${site.id} ${patch.resolutionCm} cm ${patch.label}`}
      onClick={() => onSelect({ site, patch })}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase text-gray-500">
          {patch.label}
        </span>
        <Tag className="m-0">{patch.resolutionCm} cm</Tag>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">
          RGB
        </div>
        <ImageTile
          src={patch.rgb}
          alt={`Dataset ${site.id} ${patch.label} RGB patch at ${patch.resolutionCm} cm`}
        />
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[11px] font-semibold uppercase text-gray-500">
          Ground truth
        </div>
        <GroundTruthMask
          forestCoverSrc={patch.treeCoverMask}
          deadwoodSrc={patch.mortalityMask}
          alt={`Dataset ${site.id} ${patch.label} combined tree cover and mortality ground truth mask at ${patch.resolutionCm} cm`}
          size={160}
          className="rounded-md"
        />
      </div>
    </button>
  );
}

function PatchModalViewer({
  selection,
  adminInfo,
  mode,
  onModeChange,
  onClose,
}: {
  selection: SelectedBenchmarkPatch | null;
  adminInfo: BenchmarkDatasetAdminInfo | undefined;
  mode: PatchViewerMode;
  onModeChange: (mode: PatchViewerMode) => void;
  onClose: () => void;
}) {
  if (!selection) return null;

  const { site, patch } = selection;
  const location = formatDatasetLocationLabels(adminInfo, false);
  const coarseBiome = getCoarseBiomeGroup(site.biome);
  const capturedDate = formatAcquisitionDate(adminInfo, false);
  const subtitleParts = [
    location.primary !== "Location unavailable" ? location.primary : null,
    location.secondary,
    coarseBiome,
    capturedDate !== "Unknown" ? capturedDate : null,
  ].filter(Boolean) as string[];

  return (
    <Modal
      open
      centered
      width={920}
      footer={null}
      title={null}
      onCancel={onClose}
      destroyOnClose
      aria-label={`Dataset ${site.id} ${patch.label} at ${patch.resolutionCm} cm`}
    >
      <div className="space-y-5">
        <div className="-mt-1 pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold tabular-nums text-gray-950">
              {site.id}
            </span>
            <span className="text-gray-300" aria-hidden>
              ·
            </span>
            <span className="text-lg font-semibold text-gray-800">
              {patch.label}
            </span>
            <Tag color="green" className="m-0 ml-1">
              {patch.resolutionCm} cm
            </Tag>
          </div>
          {subtitleParts.length > 0 && (
            <div className="mt-1 text-sm text-gray-500">
              {subtitleParts.join(" · ")}
            </div>
          )}
        </div>

        <Segmented
          block
          value={mode}
          options={[
            { label: "RGB", value: "rgb" },
            { label: "Overlay", value: "overlay" },
            { label: "Mask", value: "mask" },
          ]}
          onChange={(value) => onModeChange(value as PatchViewerMode)}
        />

        <div
          className="relative mx-auto aspect-square w-full overflow-hidden rounded-xl bg-gray-100 shadow-lg ring-1 ring-black/5"
          style={{ maxWidth: "min(820px, calc(100vh - 260px))" }}
        >
          <img
            src={patch.rgb}
            alt={`Dataset ${site.id} ${patch.label} RGB patch at ${patch.resolutionCm} cm`}
            className="h-full w-full object-cover"
          />
          <GroundTruthMask
            forestCoverSrc={patch.treeCoverMask}
            deadwoodSrc={patch.mortalityMask}
            alt={`Dataset ${site.id} ${patch.label} tree cover and mortality overlay at ${patch.resolutionCm} cm`}
            mode="transparent"
            opacity={0.55}
            size={512}
            className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-150 ${
              mode === "overlay" ? "opacity-100" : "opacity-0"
            }`}
          />
          <div
            className={`absolute inset-0 transition-opacity duration-150 ${
              mode === "mask" ? "opacity-100" : "opacity-0"
            }`}
          >
            <GroundTruthMask
              forestCoverSrc={patch.treeCoverMask}
              deadwoodSrc={patch.mortalityMask}
              alt={`Dataset ${site.id} ${patch.label} ground truth mask at ${patch.resolutionCm} cm`}
              size={512}
              className="h-full w-full border-0"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <GroundTruthLegend />
          <Button
            type="link"
            size="small"
            href={`/dataset/${site.id}`}
            icon={<SelectOutlined />}
            className="px-0 font-semibold text-[#1B5E35]"
          >
            Open dataset {site.id}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function GroundTruthLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
      <span className="text-gray-500">Legend</span>
      <span className="inline-flex items-center gap-1.5 rounded-md bg-[#BDBDBD]/25 px-2 py-1 text-gray-700">
        <span
          className="h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: GROUND_TRUTH_COLORS.background }}
        />
        Background
      </span>
      <span
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-white"
        style={{ backgroundColor: GROUND_TRUTH_COLORS.forestCover }}
      >
        <span className="h-2.5 w-2.5 rounded-sm bg-white/90" />
        Tree cover
      </span>
      <span
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-white"
        style={{ backgroundColor: GROUND_TRUTH_COLORS.deadwood }}
      >
        <span className="h-2.5 w-2.5 rounded-sm bg-white/90" />
        Mortality
      </span>
    </div>
  );
}

function DatasetAdminCell({
  site,
  adminInfo,
  isAdminInfoLoading,
  resolutionFilter,
  onResolutionChange,
}: {
  site: BenchmarkDatasetSite;
  adminInfo: BenchmarkDatasetAdminInfo | undefined;
  isAdminInfoLoading: boolean;
  resolutionFilter: GalleryResolutionFilter;
  onResolutionChange: (value: GalleryResolutionFilter) => void;
}) {
  const location = formatDatasetLocationLabels(adminInfo, isAdminInfoLoading);
  const capturedDate = formatAcquisitionDate(adminInfo, isAdminInfoLoading);
  const platform = formatPlatform(adminInfo?.platform, isAdminInfoLoading);
  const coarseBiome = getCoarseBiomeGroup(site.biome);
  const authors = (adminInfo?.authors ?? []).filter(
    (author): author is string => Boolean(author && author.trim().length > 0),
  );
  const authorsLabel = authors.length > 0 ? authors.join(", ") : null;

  return (
    <div className="sticky left-0 z-10 box-border flex w-[200px] shrink-0 flex-col border-r border-gray-200 bg-white p-4">
      <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
        <img
          src={makeThumbnailUrl(site)}
          alt={`Dataset ${site.id} thumbnail`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 via-black/20 to-transparent" />
        <div className="absolute left-2 top-2 rounded-md bg-white/95 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-gray-900 shadow-sm">
          {site.id}
        </div>
        <div className="absolute bottom-2 left-2 right-2">
          <span className="inline-flex max-w-full items-center rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#1B5E35] shadow-sm">
            <span className="truncate">{coarseBiome}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col pt-3">
        <div>
          <p
            className="m-0 text-[13px] font-semibold leading-[18px] text-gray-950"
            title={location.primary}
          >
            {location.primary}
          </p>
          {location.secondary && (
            <p
              className="m-0 mt-0.5 text-[11px] leading-[14px] text-gray-500"
              title={location.secondary}
            >
              {location.secondary}
            </p>
          )}
        </div>

        <div className="mt-2.5 space-y-1 text-[11px] leading-4 text-gray-700">
          <div className="flex items-center gap-1.5">
            <CalendarOutlined
              aria-hidden
              className="shrink-0 text-[12px] text-gray-400"
            />
            <span className="truncate font-medium">{capturedDate}</span>
            <span aria-hidden className="text-gray-300">
              ·
            </span>
            <span className="truncate font-medium">{platform}</span>
          </div>
          {authorsLabel && (
            <div className="flex items-start gap-1.5">
              <TeamOutlined
                aria-hidden
                className="mt-[2px] shrink-0 text-[12px] text-gray-400"
              />
              <span className="line-clamp-2 font-medium" title={authorsLabel}>
                {authorsLabel}
              </span>
            </div>
          )}
        </div>

        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Resolution <span className="font-normal text-gray-400">(cm)</span>
          </div>
          <Tooltip
            title="Filter the entire gallery by patch resolution"
            mouseEnterDelay={0.4}
          >
            <Segmented
              block
              size="small"
              value={resolutionFilter}
              options={galleryResolutionOptions}
              onChange={(value) =>
                onResolutionChange(value as GalleryResolutionFilter)
              }
              aria-label="Filter all dataset rows by patch resolution"
            />
          </Tooltip>
        </div>

        <div className="mt-auto pt-4">
          <Button
            block
            size="small"
            href={`/dataset/${site.id}`}
            icon={<SelectOutlined />}
          >
            Open Dataset {site.id}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DatasetPatchRow({
  site,
  resolutionFilter,
  adminInfo,
  isAdminInfoLoading,
  onSelectPatch,
  onScrollGallery,
  onResolutionChange,
}: {
  site: BenchmarkDatasetSite;
  resolutionFilter: GalleryResolutionFilter;
  adminInfo: BenchmarkDatasetAdminInfo | undefined;
  isAdminInfoLoading: boolean;
  onSelectPatch: (selection: SelectedBenchmarkPatch) => void;
  onScrollGallery: (direction: -1 | 1) => void;
  onResolutionChange: (value: GalleryResolutionFilter) => void;
}) {
  const patches = useMemo(
    () =>
      resolutionFilter === "all"
        ? [
            ...getBenchmarkPatchGridImages(site, 20),
            ...getBenchmarkPatchGridImages(site, 10),
            ...getBenchmarkPatchGridImages(site, 5),
          ]
        : getBenchmarkPatchGridImages(
            site,
            Number(resolutionFilter) as BenchmarkPatchResolution,
          ),
    [resolutionFilter, site],
  );

  return (
    <div className="group/row flex min-w-max items-stretch bg-[#eef3f0] ring-1 ring-[#b9c4be]/80">
      <DatasetAdminCell
        site={site}
        adminInfo={adminInfo}
        isAdminInfoLoading={isAdminInfoLoading}
        resolutionFilter={resolutionFilter}
        onResolutionChange={onResolutionChange}
      />
      <div className="relative flex gap-3 bg-[#eef3f0] p-4 transition-colors duration-150 group-hover/row:bg-[#e6ece8]">
        <Tooltip title="Previous patches" mouseEnterDelay={0.3}>
          <div className="pointer-events-none sticky left-[216px] z-20 flex w-0 shrink-0 items-center">
            <Button
              shape="circle"
              size="large"
              icon={<LeftOutlined />}
              aria-label="Scroll gallery one patch left"
              className="pointer-events-auto border-gray-200 bg-white/95 text-gray-700 opacity-85 shadow-sm transition group-hover/row:opacity-100 hover:border-[#1B5E35]/60 hover:text-[#1B5E35]"
              onClick={() => onScrollGallery(-1)}
            />
          </div>
        </Tooltip>
        <Tooltip title="Next patches" mouseEnterDelay={0.3}>
          <div className="pointer-events-none sticky left-[calc(100vw-104px)] z-20 flex w-0 shrink-0 items-center">
            <Button
              shape="circle"
              size="large"
              icon={<RightOutlined />}
              aria-label="Scroll gallery one patch right"
              className="pointer-events-auto border-gray-200 bg-white/95 text-gray-700 opacity-85 shadow-sm transition group-hover/row:opacity-100 hover:border-[#1B5E35]/60 hover:text-[#1B5E35]"
              onClick={() => onScrollGallery(1)}
            />
          </div>
        </Tooltip>
        {patches.map((patch) => (
          <PatchCard
            key={`${site.id}-${patch.resolutionCm}-${patch.patchIndex}`}
            site={site}
            patch={patch}
            onSelect={onSelectPatch}
          />
        ))}
      </div>
    </div>
  );
}

interface DteAerialBenchmarkGalleryProps {
  collection: BenchmarkDatasetCollection;
  adminInfoByDatasetId: Map<number, BenchmarkDatasetAdminInfo>;
  isAdminInfoLoading: boolean;
}

export function DteAerialBenchmarkGallery({
  collection,
  adminInfoByDatasetId,
  isAdminInfoLoading,
}: DteAerialBenchmarkGalleryProps) {
  const [resolutionFilter, setResolutionFilter] =
    useState<GalleryResolutionFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("dataset");
  const [selectedPatch, setSelectedPatch] =
    useState<SelectedBenchmarkPatch | null>(null);
  const [patchViewerMode, setPatchViewerMode] =
    useState<PatchViewerMode>("overlay");
  const [, startResolutionTransition] = useTransition();
  const galleryScrollRef = useRef<HTMLDivElement>(null);

  const handleResolutionChange = useCallback(
    (value: GalleryResolutionFilter) => {
      startResolutionTransition(() => {
        setResolutionFilter(value);
      });
    },
    [],
  );

  const handleScrollGallery = useCallback((direction: -1 | 1) => {
    const container = galleryScrollRef.current;
    if (!container) return;
    container.scrollBy({
      left: direction * GALLERY_PATCH_STEP_PX,
      behavior: "smooth",
    });
  }, []);

  const handleSelectPatch = useCallback((selection: SelectedBenchmarkPatch) => {
    setSelectedPatch(selection);
    setPatchViewerMode("overlay");
  }, []);

  const sortedSites = useMemo(
    () => sortSites(collection.sites, sortKey),
    [collection.sites, sortKey],
  );

  return (
    <section className="pb-16">
      <PatchModalViewer
        selection={selectedPatch}
        adminInfo={
          selectedPatch
            ? adminInfoByDatasetId.get(selectedPatch.site.id)
            : undefined
        }
        mode={patchViewerMode}
        onModeChange={setPatchViewerMode}
        onClose={() => setSelectedPatch(null)}
      />

      <div className="mx-auto max-w-7xl px-4 md:px-8">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[#1B5E35]">
          Dataset gallery
        </div>
        <h2 className="mt-2 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
          Browse every benchmark patch
        </h2>
        <p className="mt-3 max-w-3xl text-base leading-7 text-gray-600">
          {collection.metrics.benchmarkSites} sites ·{" "}
          {collection.metrics.benchmarkPatches} patches across{" "}
          {collection.metrics.resolutionsCm.join(", ")} cm resolutions. Use the
          controls in each dataset row to switch resolution, or change the
          dataset order below.
        </p>

        <div className="mt-6 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Sort
            </label>
            <Select
              size="middle"
              className="min-w-[180px]"
              value={sortKey}
              options={sortOptions}
              onChange={setSortKey}
            />
          </div>
          <GroundTruthLegend />
        </div>
      </div>

      <div
        ref={galleryScrollRef}
        className="benchmark-gallery-scroll overflow-x-auto border-y border-[#b9c4be] bg-[#dfe8e2]"
      >
        <div className="min-w-max space-y-5 py-5">
          {sortedSites.map((site) => (
            <DatasetPatchRow
              key={site.id}
              site={site}
              resolutionFilter={resolutionFilter}
              adminInfo={adminInfoByDatasetId.get(site.id)}
              isAdminInfoLoading={isAdminInfoLoading}
              onSelectPatch={handleSelectPatch}
              onScrollGallery={handleScrollGallery}
              onResolutionChange={handleResolutionChange}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
