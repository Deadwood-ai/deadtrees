import {
  BookOutlined,
  CalendarOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LeftOutlined,
  RightOutlined,
  SelectOutlined,
  TableOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Modal, Segmented, Select, Tag, Tooltip } from "antd";
import { useQuery } from "@tanstack/react-query";
import Feature from "ol/Feature";
import type MapBrowserEvent from "ol/MapBrowserEvent";
import Point from "ol/geom/Point";
import VectorLayer from "ol/layer/Vector";
import { Map as OLMap, View } from "ol";
import VectorSource from "ol/source/Vector";
import { fromLonLat } from "ol/proj";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import Overlay from "ol/Overlay";
import "ol/ol.css";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  dteAerialReferenceDatasetAdminInfoById,
  dteAerialReferenceDataset,
  getReferencePatchGridImages,
  ReferencePatchImageSet,
  ReferenceDatasetSite,
  ReferencePatchResolution,
  ReferenceDatasetAdminInfo,
} from "../data/referenceDatasets";
import {
  GROUND_TRUTH_COLORS,
  GroundTruthMask,
} from "../components/ReferenceDatasets/GroundTruthMask";
import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";
import {
  createOpenFreeMapLibertyLayerGroup,
  createStandardMapControls,
} from "../utils/basemaps";

type SortKey = "dataset" | "biome" | "west-east" | "north-south";
type GalleryResolutionFilter = "all" | "20" | "10" | "5";
type PatchViewerMode = "rgb" | "overlay" | "mask";

// Gallery horizontal scroll step: one PatchCard width (190px) + flex gap (12px).
const GALLERY_PATCH_STEP_PX = 202;

interface SelectedReferencePatch {
  site: ReferenceDatasetSite;
  patch: ReferencePatchImageSet;
}

const sortOptions: Array<{ label: string; value: SortKey }> = [
  { label: "Dataset ID", value: "dataset" },
  { label: "Biome", value: "biome" },
  { label: "West to east", value: "west-east" },
  { label: "North to south", value: "north-south" },
];

const getShortBiome = (biome: string) =>
  biome
    .replace("Tropical and Subtropical", "Tropical")
    .replace("Mediterranean Forests, Woodlands, and Scrub", "Mediterranean")
    .replace("Temperate Broadleaf and Mixed Forests", "Temperate broadleaf")
    .replace("Temperate Coniferous Forests", "Temperate conifer")
    .replace("Boreal Forests/Taiga", "Boreal");

const makeThumbnailUrl = (site: ReferenceDatasetSite) =>
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
  adminInfo: ReferenceDatasetAdminInfo | undefined,
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
  adminInfo: ReferenceDatasetAdminInfo | undefined,
  isLoading: boolean,
) => {
  if (!adminInfo) return isLoading ? "Loading" : "Unknown";
  if (!adminInfo.aquisition_year) return "Unknown";

  const year = Number(adminInfo.aquisition_year);
  const month = adminInfo.aquisition_month ? Number(adminInfo.aquisition_month) : undefined;
  const day = adminInfo.aquisition_day ? Number(adminInfo.aquisition_day) : undefined;

  return new Date(year, month ? month - 1 : 0, day ?? 1).toLocaleDateString("en-US", {
    year: "numeric",
    ...(month && { month: "short" }),
    ...(day && { day: "numeric" }),
  });
};

const formatPlatform = (platform: string | null | undefined, isLoading: boolean) => {
  const normalized = normalizeMetadataValue(platform);
  if (!normalized) return isLoading ? "Loading" : "Unknown";
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
};

const sortSites = (sites: ReferenceDatasetSite[], sortKey: SortKey) => {
  const sorted = [...sites];

  if (sortKey === "biome") {
    return sorted.sort((a, b) => a.biome.localeCompare(b.biome) || a.id - b.id);
  }

  if (sortKey === "west-east") {
    return sorted.sort((a, b) => a.center.lon - b.center.lon);
  }

  if (sortKey === "north-south") {
    return sorted.sort((a, b) => b.center.lat - a.center.lat);
  }

  return sorted.sort((a, b) => a.id - b.id);
};

function WorldSiteMap({ sites }: { sites: ReferenceDatasetSite[] }) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const tooltipElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mapElementRef.current || !tooltipElementRef.current) return;
    const tooltipElement = tooltipElementRef.current;

    const defaultMarkerStyle = new Style({
      image: new CircleStyle({
        radius: 7,
        fill: new Fill({ color: GROUND_TRUTH_COLORS.forestCover }),
        stroke: new Stroke({ color: "#ffffff", width: 2.5 }),
      }),
    });

    const hoverMarkerStyle = new Style({
      image: new CircleStyle({
        radius: 11,
        fill: new Fill({ color: GROUND_TRUTH_COLORS.deadwood }),
        stroke: new Stroke({ color: "#ffffff", width: 3 }),
      }),
    });

    const markerSource = new VectorSource({
      features: sites.map((site) => {
        const feature = new Feature({
          geometry: new Point(fromLonLat([site.center.lon, site.center.lat])),
          datasetId: site.id,
          biome: getShortBiome(site.biome),
        });
        feature.setStyle(defaultMarkerStyle);
        return feature;
      }),
    });

    const markerLayer = new VectorLayer({
      source: markerSource,
      zIndex: 10,
    });

    const tooltipOverlay = new Overlay({
      element: tooltipElement,
      offset: [0, -16],
      positioning: "bottom-center",
      stopEvent: false,
    });

    const map = new OLMap({
      target: mapElementRef.current,
      layers: [createOpenFreeMapLibertyLayerGroup(), markerLayer],
      overlays: [tooltipOverlay],
      controls: createStandardMapControls({
        includeZoom: false,
        includeAttribution: true,
      }),
      view: new View({
        center: fromLonLat([10, 18]),
        zoom: 1.7,
        minZoom: 1,
        maxZoom: 6,
      }),
    });

    const extent = markerSource.getExtent();
    if (extent.every(Number.isFinite)) {
      map.getView().fit(extent, {
        padding: [28, 28, 28, 28],
        maxZoom: 3.2,
      });
    }

    let hoveredFeature: Feature | null = null;

    const handlePointerMove = (event: MapBrowserEvent<PointerEvent>) => {
      const featureAtPixel = map.forEachFeatureAtPixel(event.pixel, (feature) => feature);
      const nextFeature = featureAtPixel instanceof Feature ? featureAtPixel : null;

      if (hoveredFeature && hoveredFeature !== nextFeature) {
        hoveredFeature.setStyle(defaultMarkerStyle);
      }

      hoveredFeature = nextFeature;
      map.getTargetElement().style.cursor = nextFeature ? "pointer" : "";

      if (!nextFeature) {
        tooltipOverlay.setPosition(undefined);
        return;
      }

      nextFeature.setStyle(hoverMarkerStyle);
      const geometry = nextFeature.getGeometry();
      if (geometry instanceof Point) {
        tooltipOverlay.setPosition(geometry.getCoordinates());
      }

      tooltipElement.textContent = `Dataset #${nextFeature.get("datasetId")} · ${nextFeature.get("biome")}`;
    };

    map.on("pointermove", handlePointerMove);

    return () => {
      map.un("pointermove", handlePointerMove);
      map.setTarget(undefined);
    };
  }, [sites]);

  return (
    <div className="relative h-80 overflow-hidden rounded-2xl bg-[#eef3f0] shadow-xl ring-1 ring-black/5">
      <div ref={mapElementRef} className="h-full w-full" />
      <div
        ref={tooltipElementRef}
        className="pointer-events-none rounded-md bg-white/95 px-2 py-1 text-xs font-semibold text-gray-900 shadow-sm ring-1 ring-black/10"
      />
    </div>
  );
}

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
  site: ReferenceDatasetSite;
  patch: ReferencePatchImageSet;
  onSelect: (selection: SelectedReferencePatch) => void;
}) {
  return (
    <button
      type="button"
      data-testid="reference-patch-card"
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
          alt={`Dataset ${site.id} ${patch.label} combined forest cover and deadwood ground truth mask at ${patch.resolutionCm} cm`}
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
  selection: SelectedReferencePatch | null;
  adminInfo: ReferenceDatasetAdminInfo | undefined;
  mode: PatchViewerMode;
  onModeChange: (mode: PatchViewerMode) => void;
  onClose: () => void;
}) {
  if (!selection) return null;

  const { site, patch } = selection;
  const location = formatDatasetLocationLabels(adminInfo, false);
  const shortBiome = getShortBiome(site.biome);
  const capturedDate = formatAcquisitionDate(adminInfo, false);
  const subtitleParts = [
    location.primary !== "Location unavailable" ? location.primary : null,
    location.secondary,
    shortBiome,
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
              #{site.id}
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
            alt={`Dataset ${site.id} ${patch.label} forest cover and deadwood overlay at ${patch.resolutionCm} cm`}
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
              Forest cover
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-white"
              style={{ backgroundColor: GROUND_TRUTH_COLORS.deadwood }}
            >
              <span className="h-2.5 w-2.5 rounded-sm bg-white/90" />
              Deadwood
            </span>
          </div>
          <Button
            type="link"
            size="small"
            href={`/dataset/${site.id}`}
            icon={<SelectOutlined />}
            className="px-0 font-semibold text-[#1B5E35]"
          >
            Open dataset #{site.id}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const galleryResolutionOptions: Array<{
  label: string;
  value: GalleryResolutionFilter;
}> = [
  { label: "All", value: "all" },
  { label: "5", value: "5" },
  { label: "10", value: "10" },
  { label: "20", value: "20" },
];

function DatasetAdminCell({
  site,
  adminInfo,
  isAdminInfoLoading,
  resolutionFilter,
  onResolutionChange,
}: {
  site: ReferenceDatasetSite;
  adminInfo: ReferenceDatasetAdminInfo | undefined;
  isAdminInfoLoading: boolean;
  resolutionFilter: GalleryResolutionFilter;
  onResolutionChange: (value: GalleryResolutionFilter) => void;
}) {
  const location = formatDatasetLocationLabels(adminInfo, isAdminInfoLoading);
  const capturedDate = formatAcquisitionDate(adminInfo, isAdminInfoLoading);
  const platform = formatPlatform(adminInfo?.platform, isAdminInfoLoading);
  const shortBiome = getShortBiome(site.biome);
  const authors = (adminInfo?.authors ?? []).filter((author): author is string =>
    Boolean(author && author.trim().length > 0),
  );
  const authorsLabel = authors.length > 0 ? authors.join(", ") : null;

  return (
    <div className="sticky left-0 z-10 flex w-[200px] shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
        <img
          src={makeThumbnailUrl(site)}
          alt={`Dataset ${site.id} thumbnail`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 via-black/20 to-transparent" />
        <div className="absolute left-2 top-2 rounded-md bg-white/95 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-gray-900 shadow-sm">
          #{site.id}
        </div>
        <div className="absolute bottom-2 left-2 right-2">
          <span className="inline-flex max-w-full items-center rounded-md bg-white/95 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#1B5E35] shadow-sm">
            <span className="truncate">{shortBiome}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col px-3 pb-3 pt-3">
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
            <span aria-hidden className="text-gray-300">·</span>
            <span className="truncate font-medium">{platform}</span>
          </div>
          {authorsLabel && (
            <div className="flex items-start gap-1.5">
              <TeamOutlined
                aria-hidden
                className="mt-[2px] shrink-0 text-[12px] text-gray-400"
              />
              <span
                className="line-clamp-2 font-medium"
                title={authorsLabel}
              >
                {authorsLabel}
              </span>
            </div>
          )}
        </div>

        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            Resolution{" "}
            <span className="font-normal text-gray-400">(cm)</span>
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

          <Button
            block
            size="small"
            className="mt-2"
            href={`/dataset/${site.id}`}
            icon={<SelectOutlined />}
          >
            Explore #{site.id}
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
  site: ReferenceDatasetSite;
  resolutionFilter: GalleryResolutionFilter;
  adminInfo: ReferenceDatasetAdminInfo | undefined;
  isAdminInfoLoading: boolean;
  onSelectPatch: (selection: SelectedReferencePatch) => void;
  onScrollGallery: (direction: -1 | 1) => void;
  onResolutionChange: (value: GalleryResolutionFilter) => void;
}) {
  const patches = useMemo(
    () =>
      resolutionFilter === "all"
        ? [
            ...getReferencePatchGridImages(site, 20),
            ...getReferencePatchGridImages(site, 10),
            ...getReferencePatchGridImages(site, 5),
          ]
        : getReferencePatchGridImages(site, Number(resolutionFilter) as ReferencePatchResolution),
    [resolutionFilter, site],
  );

  return (
    <div className="group/row flex min-w-max">
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

export default function DteAerialReferenceDataset() {
  const [resolutionFilter, setResolutionFilter] = useState<GalleryResolutionFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("dataset");
  const [selectedPatch, setSelectedPatch] = useState<SelectedReferencePatch | null>(null);
  const [patchViewerMode, setPatchViewerMode] = useState<PatchViewerMode>("overlay");
  const [, startResolutionTransition] = useTransition();
  const galleryScrollRef = useRef<HTMLDivElement>(null);
  const collection = dteAerialReferenceDataset;
  const datasetIds = useMemo(() => collection.sites.map((site) => site.id), [collection.sites]);
  const heroTagline = collection.title.startsWith(`${collection.name}: `)
    ? collection.title.slice(collection.name.length + 2)
    : collection.title;

  const handleResolutionChange = useCallback((value: GalleryResolutionFilter) => {
    startResolutionTransition(() => {
      setResolutionFilter(value);
    });
  }, []);

  const handleScrollGallery = useCallback((direction: -1 | 1) => {
    const container = galleryScrollRef.current;
    if (!container) return;
    container.scrollBy({
      left: direction * GALLERY_PATCH_STEP_PX,
      behavior: "smooth",
    });
  }, []);

  const handleSelectPatch = useCallback((selection: SelectedReferencePatch) => {
    setSelectedPatch(selection);
    setPatchViewerMode("overlay");
  }, []);

  const { data: adminInfoRows, isLoading: isAdminInfoLoading } = useQuery({
    queryKey: ["reference-dataset-admin-info", collection.slug, datasetIds.join(",")],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(Settings.DATA_TABLE_PUBLIC)
        .select(
          "id, admin_level_1, admin_level_2, admin_level_3, aquisition_year, aquisition_month, aquisition_day, platform, authors",
        )
        .in("id", datasetIds);

      if (error) throw error;
      return (data ?? []) as ReferenceDatasetAdminInfo[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const sortedSites = useMemo(
    () => sortSites(collection.sites, sortKey),
    [collection.sites, sortKey],
  );

  const adminInfoByDatasetId = useMemo(() => {
    const rowsById = new Map<number, ReferenceDatasetAdminInfo>(
      Object.entries(dteAerialReferenceDatasetAdminInfoById).map(([id, adminInfo]) => [
        Number(id),
        adminInfo,
      ]),
    );
    adminInfoRows?.forEach((row) => rowsById.set(Number(row.id), row));
    return rowsById;
  }, [adminInfoRows]);

  const biomeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    collection.sites.forEach((site) => {
      counts.set(getShortBiome(site.biome), (counts.get(getShortBiome(site.biome)) ?? 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [collection.sites]);

  return (
    <main className="min-h-screen bg-[#f8faf9] pt-24 md:pt-32">
      <PatchModalViewer
        selection={selectedPatch}
        adminInfo={selectedPatch ? adminInfoByDatasetId.get(selectedPatch.site.id) : undefined}
        mode={patchViewerMode}
        onModeChange={setPatchViewerMode}
        onClose={() => setSelectedPatch(null)}
      />
      <section className="border-b border-gray-200/80 bg-white">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 md:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] md:gap-12 md:px-8 md:py-24">
          <div>
            <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35] md:text-base">
              Reference dataset · {collection.shortName}
            </p>
            <h1 className="m-0 mt-3 text-4xl font-semibold leading-[1.1] text-gray-950 md:text-5xl">
              {collection.name}
            </h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-gray-600">
              {heroTagline}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Tag color="green" className="m-0">
                Golden test set
              </Tag>
              <Tag className="m-0">Static v1</Tag>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                type="primary"
                size="large"
                icon={<DownloadOutlined />}
                href={collection.links.dataset}
                className="min-h-11"
              >
                Download dataset
              </Button>
              <Button
                size="large"
                icon={<BookOutlined />}
                href={collection.links.citation}
                className="min-h-11"
              >
                Citation
              </Button>
              <Button
                size="large"
                icon={<FileTextOutlined />}
                href={collection.links.croissant}
                className="min-h-11"
              >
                Croissant metadata
              </Button>
              <span className="inline-flex items-center rounded-full bg-[#E8F3EB] px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#1B5E35]">
                Coming soon
              </span>
            </div>
          </div>

          <div>
            <WorldSiteMap sites={collection.sites} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-10 md:px-8 md:py-12">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
            {collection.stats.map((stat) => (
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
              Biome coverage
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
                        width: `${(count / collection.sites.length) * 100}%`,
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

      <section className="pb-16">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-[#1B5E35]">
            <TableOutlined />
            Dataset gallery
          </div>
          <h2 className="mt-2 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
            Browse every benchmark patch
          </h2>
          <p className="mt-3 max-w-3xl text-base leading-7 text-gray-600">
            {collection.stats[0].value} sites · {collection.stats[1].value} patches across 5, 10, and 20 cm resolutions.
            Filter each row by resolution from its title cell, or change the dataset order below.
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
                Forest cover
              </span>
              <span
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-white"
                style={{ backgroundColor: GROUND_TRUTH_COLORS.deadwood }}
              >
                <span className="h-2.5 w-2.5 rounded-sm bg-white/90" />
                Deadwood
              </span>
            </div>
          </div>
        </div>

        <div
          ref={galleryScrollRef}
          className="reference-gallery-scroll overflow-x-auto border-y border-[#b9c4be] bg-[#eef3f0]"
        >
          <div className="min-w-max divide-y-2 divide-[#b9c4be]/60">
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

      <section className="border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-3xl">
            <p className="m-0 text-sm font-semibold uppercase tracking-wider text-[#1B5E35]">
              Release artifacts
            </p>
            <h2 className="m-0 mt-3 text-3xl font-semibold leading-tight text-gray-950 md:text-4xl">
              What you'll be able to download
            </h2>
            <p className="mt-3 text-base leading-7 text-gray-600">
              The gallery above is the live preview of the dataset. The official release will bundle the patches with metadata, citation, and machine-readable schemas.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: <DatabaseOutlined className="text-xl text-[#1B5E35]" />,
                title: "Dataset package",
                description:
                  "RGB patches and reference masks at 5, 10, and 20 cm, packaged for Hugging Face and FreiData.",
              },
              {
                icon: <BookOutlined className="text-xl text-[#1B5E35]" />,
                title: "Citation",
                description:
                  "Paper citation, DOI, BibTeX entry, and per-site attribution following CC BY.",
              },
              {
                icon: <FileTextOutlined className="text-xl text-[#1B5E35]" />,
                title: "Croissant metadata",
                description:
                  "Machine-readable schema describing splits, fields, and responsible AI considerations.",
              },
            ].map((card) => (
              <div
                key={card.title}
                className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6 transition-shadow hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  {card.icon}
                  <span className="inline-flex items-center rounded-full bg-[#E8F3EB] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#1B5E35]">
                    Coming soon
                  </span>
                </div>
                <h3 className="m-0 mt-4 text-lg font-semibold text-gray-950">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-gray-600">
                  {card.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
