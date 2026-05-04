export type BenchmarkPatchResolution = 5 | 10 | 20;

export interface BenchmarkDatasetSite {
  id: number;
  fileName: string;
  biome: string;
  license: string;
  citationUrl: string | null;
  thumbnailPath: string;
  exportSeed: string;
  center: {
    lon: number;
    lat: number;
  };
  patchCount: number;
}

export interface BenchmarkDatasetAdminInfo {
  id: number | string;
  admin_level_1: string | null;
  admin_level_2: string | null;
  admin_level_3: string | null;
  aquisition_year: number | string | null;
  aquisition_month: number | string | null;
  aquisition_day: number | string | null;
  platform: string | null;
  authors: string[] | null;
}

export interface BenchmarkPatchImageSet {
  resolutionCm: BenchmarkPatchResolution;
  patchIndex: number;
  label: string;
  rgb: string;
  treeCoverMask: string;
  mortalityMask: string;
}

export interface BenchmarkDatasetCollection {
  slug: string;
  name: string;
  shortName: string;
  title: string;
  status: "available" | "coming-soon";
  summary: string;
  metrics: {
    benchmarkSites: number;
    benchmarkPatches: number;
    patchSizePx: number;
    resolutionsCm: BenchmarkPatchResolution[];
  };
  links: {
    dataset: string;
  };
  sites: BenchmarkDatasetSite[];
}

export interface BenchmarkDatasetStat {
  label: string;
  value: string;
}

export const BENCHMARK_EXPORT_BASE_URL =
  "https://data2.deadtrees.earth/reference/69e57f93-d003-4b64-9108-fe3dfa654918";

export const getCoarseBiomeGroup = (biome: string) => {
  const normalized = biome.toLowerCase();
  if (normalized.includes("tropical")) return "(Sub)tropical";
  if (normalized.includes("mediterranean")) return "Drylands";
  if (normalized.includes("boreal") || normalized.includes("montane")) {
    return "Boreal and montane";
  }
  if (normalized.includes("temperate")) return "Temperate";
  return biome;
};

export const dteAerialBenchmarkDatasetAdminInfoById: Record<
  number,
  BenchmarkDatasetAdminInfo
> = {
  375: {
    id: 375,
    admin_level_1: "Spain",
    admin_level_2: "Granada",
    admin_level_3: "Arenas del Rey",
    aquisition_year: 2023,
    aquisition_month: 9,
    aquisition_day: 16,
    platform: "drone",
    authors: ["Clemens Mosig", "Oscar Perez-Priego"],
  },
  400: {
    id: 400,
    admin_level_1: "Spain",
    admin_level_2: "Malaga",
    admin_level_3: "Canillas de Albaida",
    aquisition_year: 2023,
    aquisition_month: 9,
    aquisition_day: 20,
    platform: "drone",
    authors: ["Clemens Mosig", "Oscar Perez-Priego"],
  },
  435: {
    id: 435,
    admin_level_1: "Panama",
    admin_level_2: "La Chorrera",
    admin_level_3: "",
    aquisition_year: 2018,
    aquisition_month: 11,
    aquisition_day: 26,
    platform: "drone",
    authors: [
      "Helene C. Muller-Landau",
      "Vicente Garcia Vasquez",
      "Melvin Milton Hernandez",
    ],
  },
  868: {
    id: 868,
    admin_level_1: "New Zealand",
    admin_level_2: "Western Bay of Plenty",
    admin_level_3: "",
    aquisition_year: 2023,
    aquisition_month: 10,
    aquisition_day: 25,
    platform: "drone",
    authors: ["Contributors of Open Imagery Network"],
  },
  1371: {
    id: 1371,
    admin_level_1: "Norway",
    admin_level_2: "As",
    admin_level_3: "",
    aquisition_year: 2018,
    aquisition_month: 5,
    aquisition_day: 15,
    platform: "drone",
    authors: ["Stefano Puliti", "Rasmus Astrup"],
  },
  1381: {
    id: 1381,
    admin_level_1: "Norway",
    admin_level_2: "Stange",
    admin_level_3: "",
    aquisition_year: 2018,
    aquisition_month: 8,
    aquisition_day: 21,
    platform: "drone",
    authors: ["Stefano Puliti", "Rasmus Astrup"],
  },
  1396: {
    id: 1396,
    admin_level_1: "Norway",
    admin_level_2: "Lier",
    admin_level_3: "",
    aquisition_year: 2019,
    aquisition_month: 5,
    aquisition_day: 23,
    platform: "drone",
    authors: ["Stefano Puliti", "Rasmus Astrup"],
  },
  1406: {
    id: 1406,
    admin_level_1: "Norway",
    admin_level_2: "Mandalseid",
    admin_level_3: "",
    aquisition_year: 2021,
    aquisition_month: 6,
    aquisition_day: 8,
    platform: "drone",
    authors: ["Stefano Puliti", "Rasmus Astrup"],
  },
  3251: {
    id: 3251,
    admin_level_1: "Indonesia",
    admin_level_2: "Langkat",
    admin_level_3: "Bukit Mas",
    aquisition_year: 2012,
    aquisition_month: 2,
    aquisition_day: 15,
    platform: "drone",
    authors: ["Serge Wich"],
  },
  3341: {
    id: 3341,
    admin_level_1: "Brazil",
    admin_level_2: "Frederico Westphalen",
    admin_level_3: "",
    aquisition_year: 2017,
    aquisition_month: 9,
    aquisition_day: 22,
    platform: "drone",
    authors: ["Fabio Marcelo Breunig"],
  },
  3834: {
    id: 3834,
    admin_level_1: "Indonesia",
    admin_level_2: "Kutai Timur",
    admin_level_3: "Sangatta Selatan",
    aquisition_year: 2014,
    aquisition_month: 8,
    aquisition_day: 19,
    platform: "drone",
    authors: ["Serge Wich"],
  },
  4010: {
    id: 4010,
    admin_level_1: "Portugal",
    admin_level_2: "Ribeira Brava",
    admin_level_3: "",
    aquisition_year: 2024,
    aquisition_month: 9,
    aquisition_day: 11,
    platform: "drone",
    authors: ["Teja Kattenborn"],
  },
  4087: {
    id: 4087,
    admin_level_1: "Germany",
    admin_level_2: "Tubingen",
    admin_level_3: "Rottenburg am Neckar",
    aquisition_year: 2025,
    aquisition_month: 7,
    aquisition_day: 27,
    platform: "drone",
    authors: ["PRIMA-Wald"],
  },
  4088: {
    id: 4088,
    admin_level_1: "Germany",
    admin_level_2: "Ortenaukreis",
    admin_level_3: "Oppenau",
    aquisition_year: 2025,
    aquisition_month: 7,
    aquisition_day: 31,
    platform: "drone",
    authors: ["PRIMA-Wald"],
  },
  4181: {
    id: 4181,
    admin_level_1: "Chile",
    admin_level_2: "Talca",
    admin_level_3: "",
    aquisition_year: 2017,
    aquisition_month: 4,
    aquisition_day: 12,
    platform: "drone",
    authors: ["Fabian Fassnacht"],
  },
  4182: {
    id: 4182,
    admin_level_1: "Chile",
    admin_level_2: "Talca",
    admin_level_3: "",
    aquisition_year: 2016,
    aquisition_month: 3,
    aquisition_day: 16,
    platform: "drone",
    authors: ["Fabian Fassnacht"],
  },
  4471: {
    id: 4471,
    admin_level_1: "New Zealand",
    admin_level_2: "Marlborough",
    admin_level_3: "",
    aquisition_year: 2023,
    aquisition_month: 8,
    aquisition_day: 17,
    platform: "drone",
    authors: ["GeoNadir"],
  },
  5387: {
    id: 5387,
    admin_level_1: "United States",
    admin_level_2: "Washington",
    admin_level_3: "",
    aquisition_year: 2015,
    aquisition_month: 8,
    aquisition_day: 7,
    platform: "drone",
    authors: ["DroneDB"],
  },
  5463: {
    id: 5463,
    admin_level_1: "United States",
    admin_level_2: "Yuba",
    admin_level_3: "",
    aquisition_year: 2023,
    aquisition_month: 6,
    aquisition_day: 23,
    platform: "drone",
    authors: ["UC Davis Forest Change Analysis Lab"],
  },
  5584: {
    id: 5584,
    admin_level_1: "United States",
    admin_level_2: "Nevada",
    admin_level_3: "",
    aquisition_year: 2023,
    aquisition_month: 8,
    aquisition_day: 4,
    platform: "drone",
    authors: ["UC Davis Forest Change Analysis Lab"],
  },
  5756: {
    id: 5756,
    admin_level_1: "United States",
    admin_level_2: "Santa Clara",
    admin_level_3: "",
    aquisition_year: 2020,
    aquisition_month: 5,
    aquisition_day: 12,
    platform: "drone",
    authors: [
      "UC Natural Reserve System and Becca Fenwick, Justin Cummings, Jacob Flannagan, Clancy McConnell, Sean Hogan",
    ],
  },
  5783: {
    id: 5783,
    admin_level_1: "United States",
    admin_level_2: "Santa Clara",
    admin_level_3: "",
    aquisition_year: 2023,
    aquisition_month: 8,
    aquisition_day: 17,
    platform: "drone",
    authors: [
      "UC Natural Reserve System and Becca Fenwick, Justin Cummings, Jacob Flannagan, Clancy McConnell, Sean Hogan",
    ],
  },
  5786: {
    id: 5786,
    admin_level_1: "United States",
    admin_level_2: "Santa Clara",
    admin_level_3: "",
    aquisition_year: 2023,
    aquisition_month: 8,
    aquisition_day: 17,
    platform: "drone",
    authors: [
      "UC Natural Reserve System and Becca Fenwick, Justin Cummings, Jacob Flannagan, Clancy McConnell, Sean Hogan",
    ],
  },
  5931: {
    id: 5931,
    admin_level_1: "United States",
    admin_level_2: "Riverside",
    admin_level_3: "",
    aquisition_year: 2024,
    aquisition_month: 8,
    aquisition_day: 11,
    platform: "drone",
    authors: ["UC Davis Forest Change Analysis Lab"],
  },
  6445: {
    id: 6445,
    admin_level_1: "South Korea",
    admin_level_2: "Andong",
    admin_level_3: "",
    aquisition_year: 2025,
    aquisition_month: 7,
    aquisition_day: 3,
    platform: "drone",
    authors: ["Youngryel Ryu"],
  },
};

const makeBenchmarkPatchBase = (
  dataset: BenchmarkDatasetSite,
  resolutionCm: BenchmarkPatchResolution,
  patchIndex = 0,
) => {
  if (resolutionCm === 20) {
    return `${dataset.id}_20_${dataset.exportSeed}_20cm`;
  }

  if (resolutionCm === 10) {
    return `${dataset.id}_${dataset.exportSeed}_${patchIndex}_10cm`;
  }

  const row = Math.floor(patchIndex / 4);
  const column = patchIndex % 4;
  return `${dataset.id}_${row}_${column}_5cm`;
};

export const getBenchmarkPatchImages = (
  dataset: BenchmarkDatasetSite,
  resolutionCm: BenchmarkPatchResolution,
  patchIndex = 0,
): BenchmarkPatchImageSet => {
  const base = makeBenchmarkPatchBase(dataset, resolutionCm, patchIndex);
  const folder = `${BENCHMARK_EXPORT_BASE_URL}/${dataset.id}/png`;

  return {
    resolutionCm,
    patchIndex,
    label: `Patch ${patchIndex + 1}`,
    rgb: `${folder}/${base}.png`,
    treeCoverMask: `${folder}/${base}_forestcover_ref.png`,
    mortalityMask: `${folder}/${base}_deadwood_ref.png`,
  };
};

export const getBenchmarkPatchGridImages = (
  dataset: BenchmarkDatasetSite,
  resolutionCm: BenchmarkPatchResolution,
): BenchmarkPatchImageSet[] => {
  const patchCountByResolution: Record<BenchmarkPatchResolution, number> = {
    20: 1,
    10: 4,
    5: 16,
  };

  return Array.from(
    { length: patchCountByResolution[resolutionCm] },
    (_, index) => getBenchmarkPatchImages(dataset, resolutionCm, index),
  );
};

export const getBenchmarkDatasetStats = (
  collection: BenchmarkDatasetCollection,
): BenchmarkDatasetStat[] => [
  {
    label: "Benchmark sites",
    value: collection.metrics.benchmarkSites.toString(),
  },
  {
    label: "Benchmark patches",
    value: collection.metrics.benchmarkPatches.toString(),
  },
  {
    label: "Patch size",
    value: `${collection.metrics.patchSizePx} px`,
  },
  {
    label: "Resolutions",
    value: `${collection.metrics.resolutionsCm.join(", ")} cm`,
  },
];

export const dteAerialBenchmarkDataset: BenchmarkDatasetCollection = {
  slug: "dte-aerial-bench",
  name: "DTE-aerial-bench",
  shortName: "DTE-aerial-bench",
  title:
    "DTE-aerial-bench: A multi-resolution manually labelled aerial benchmark for tree cover and mortality segmentation",
  status: "available",
  summary:
    "A curated aerial benchmark for tree cover and mortality segmentation, built from high-resolution drone and aircraft orthophotos with expert ground-truth masks.",
  metrics: {
    benchmarkSites: 25,
    benchmarkPatches: 525,
    patchSizePx: 1024,
    resolutionsCm: [5, 10, 20],
  },
  links: {
    dataset: "#dataset-download-placeholder",
  },
  sites: [
    {
      id: 375,
      fileName: "spain_16_09_2023_andy_8_ortho.tif",
      biome: "Mediterranean Forests, Woodlands, and Scrub",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "7f4f2ccf-ea6d-4121-b458-1e7df383cb8b/375_thumbnail.jpg",
      exportSeed: "1761659176350",
      center: { lon: -3.85384, lat: 36.90486 },
      patchCount: 21,
    },
    {
      id: 400,
      fileName: "spain_20_09_2023_south_tejeda_4_ortho.tif",
      biome: "Mediterranean Forests, Woodlands, and Scrub",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "d20ffc69-1256-46b5-8abe-42743ab91bde/400_thumbnail.jpg",
      exportSeed: "1762246508822",
      center: { lon: -3.9977, lat: 36.85925 },
      patchCount: 21,
    },
    {
      id: 435,
      fileName: "BCI_50ha_2018_11_26_global.tif",
      biome: "Tropical and Subtropical Moist Broadleaf Forests",
      license: "CC BY",
      citationUrl: "https://doi.org/10.25573/data.24782016",
      thumbnailPath: "c8a27049-d93d-436d-b4e5-5f423aab985f/435_thumbnail.jpg",
      exportSeed: "1761655691349",
      center: { lon: -79.85098, lat: 9.15454 },
      patchCount: 21,
    },
    {
      id: 868,
      fileName: "6544f584f0cdb700011d7aba.tif",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "f05f654d-747b-4ea9-b06b-3dc667574b0b/868_thumbnail.jpg",
      exportSeed: "1769430182985",
      center: { lon: 176.19853, lat: -37.8236 },
      patchCount: 21,
    },
    {
      id: 1371,
      fileName: "20180515.tif",
      biome: "Boreal Forests/Taiga",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "1f481b77-6ad5-4e65-94a8-fb6bd9f842e7/1371_thumbnail.jpg",
      exportSeed: "1762700398977",
      center: { lon: 10.78414, lat: 59.67004 },
      patchCount: 21,
    },
    {
      id: 1381,
      fileName: "20180821.tif",
      biome: "Boreal Forests/Taiga",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "d1a407af-e423-4609-9252-af9bd256f0e1/1381_thumbnail.jpg",
      exportSeed: "1762819003883",
      center: { lon: 11.5016, lat: 60.62977 },
      patchCount: 21,
    },
    {
      id: 1396,
      fileName: "20190523.tif",
      biome: "Boreal Forests/Taiga",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "c5953896-538c-4f3e-8cfa-2f0ade81da20/1396_thumbnail.jpg",
      exportSeed: "1761725189801",
      center: { lon: 10.14918, lat: 59.85898 },
      patchCount: 21,
    },
    {
      id: 1406,
      fileName: "20210608_2.tif",
      biome: "Boreal Forests/Taiga",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "0d099013-e7b6-4024-9884-97e162ac6b9c/1406_thumbnail.jpg",
      exportSeed: "1761638862743",
      center: { lon: 11.42959, lat: 64.26842 },
      patchCount: 21,
    },
    {
      id: 3251,
      fileName: "aras_nepal_15022012_RGB_orthomosaic.tif",
      biome: "Tropical and Subtropical Moist Broadleaf Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "9be88d59-2140-4e7a-aae5-45aa01ef40d7/3251_thumbnail.jpg",
      exportSeed: "1761645491783",
      center: { lon: 98.08785, lat: 3.96959 },
      patchCount: 26,
    },
    {
      id: 3341,
      fileName: "Voo_P4_20170922_80mag_9min_Mosaico.tif",
      biome: "Tropical and Subtropical Moist Broadleaf Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "0c3e6ddc-6bd3-4249-b67f-c7d1b869e3f4/3341_thumbnail.jpg",
      exportSeed: "1761050217641",
      center: { lon: -53.42594, lat: -27.39328 },
      patchCount: 21,
    },
    {
      id: 3834,
      fileName:
        "2013_08_27_Tanjung Survey 110m horizontal 150m vert_RGB_orthomosaic.tif",
      biome: "Tropical and Subtropical Moist Broadleaf Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "c0fc439e-a9ac-49ff-b8e5-bae5fbea038a/3834_thumbnail.jpg",
      exportSeed: "1761123016903",
      center: { lon: 117.44007, lat: 0.57411 },
      patchCount: 21,
    },
    {
      id: 4010,
      fileName: "odm_orthophoto_lombo.tif",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "d88adc65-e486-40bf-8f23-0d86d0b3754c/4010_thumbnail.jpg",
      exportSeed: "1768248869627",
      center: { lon: -17.01648, lat: 32.74154 },
      patchCount: 21,
    },
    {
      id: 4087,
      fileName: "DJI_202507271025_012_Sonntag.zip",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "89e162a7-d91d-4884-a077-35b0e95d751c/4087_thumbnail.jpg",
      exportSeed: "1761034949701",
      center: { lon: 8.96256, lat: 48.44915 },
      patchCount: 21,
    },
    {
      id: 4088,
      fileName: "PIRMA-Wald_Test_Ohlsbach.zip",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "049caac4-df9c-4735-8bd6-9515bd8a9cfc/4088_thumbnail.jpg",
      exportSeed: "1761813561329",
      center: { lon: 8.19973, lat: 48.51928 },
      patchCount: 21,
    },
    {
      id: 4181,
      fileName: "674.tif",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: "https://data.geonadir.com/image-collection-details/674",
      thumbnailPath: "f499c10d-66d5-4be5-8294-78c0c18c6f39/4181_thumbnail.jpg",
      exportSeed: "1768225381580",
      center: { lon: -72.17642, lat: -35.2324 },
      patchCount: 21,
    },
    {
      id: 4182,
      fileName: "679.tif",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: "https://data.geonadir.com/image-collection-details/679",
      thumbnailPath: "a19c6e39-ed10-4dd7-af91-25f63f5d9da1/4182_thumbnail.jpg",
      exportSeed: "1764090893821",
      center: { lon: -72.1375, lat: -35.26552 },
      patchCount: 21,
    },
    {
      id: 4471,
      fileName: "3066.tif",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: "https://data.geonadir.com/image-collection-details/3066",
      thumbnailPath: "1b0d5cff-a5fa-4a97-9af0-e6baeddd4b99/4471_thumbnail.jpg",
      exportSeed: "1768211503784",
      center: { lon: 173.66067, lat: -41.57676 },
      patchCount: 21,
    },
    {
      id: 5387,
      fileName: "odm_orthophoto.tif",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "05b87d57-5680-4478-aacb-9a6966922138/5387_thumbnail.jpg",
      exportSeed: "1761037805083",
      center: { lon: -72.74669, lat: 44.33445 },
      patchCount: 21,
    },
    {
      id: 5463,
      fileName: "mission_000097_ortho-dsm-ptcloud_openforestobservatory.tif",
      biome: "Temperate Coniferous Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "c2874a35-bee4-4866-a727-550b22a25f90/5463_thumbnail.jpg",
      exportSeed: "1761562313850",
      center: { lon: -121.05988, lat: 39.47847 },
      patchCount: 21,
    },
    {
      id: 5584,
      fileName: "mission_000252_ortho-dsm-ptcloud_openforestobservatory.tif",
      biome: "Temperate Coniferous Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "ad8b3ad0-771d-4d03-8d43-2f9369a34ed4/5584_thumbnail.jpg",
      exportSeed: "1761219556800",
      center: { lon: -120.45045, lat: 39.4227 },
      patchCount: 21,
    },
    {
      id: 5756,
      fileName: "mission_000547_ortho-dsm-ptcloud_openforestobservatory.tif",
      biome: "Mediterranean Forests, Woodlands, and Scrub",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "e071bb98-c403-4703-b7d2-27acaf666052/5756_thumbnail.jpg",
      exportSeed: "1760969308574",
      center: { lon: -121.72501, lat: 37.39333 },
      patchCount: 21,
    },
    {
      id: 5783,
      fileName: "mission_000610_ortho-dsm-ptcloud_openforestobservatory.tif",
      biome: "Mediterranean Forests, Woodlands, and Scrub",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "150d415c-ed3e-4b90-af1b-dda191e86fc9/5783_thumbnail.jpg",
      exportSeed: "1761552733222",
      center: { lon: -121.72784, lat: 37.37656 },
      patchCount: 21,
    },
    {
      id: 5786,
      fileName: "mission_000613_ortho-dsm-ptcloud_openforestobservatory.tif",
      biome: "Mediterranean Forests, Woodlands, and Scrub",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "d17b518f-d500-404b-b1ad-bc8c03ee1557/5786_thumbnail.jpg",
      exportSeed: "1761224373009",
      center: { lon: -121.72519, lat: 37.3933 },
      patchCount: 21,
    },
    {
      id: 5931,
      fileName: "mission_001307_ortho-dsm-ptcloud_openforestobservatory.tif",
      biome: "Mediterranean Forests, Woodlands, and Scrub",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "c2983bf0-c668-4dc2-a782-8f6b67ec715b/5931_thumbnail.jpg",
      exportSeed: "1761036665707",
      center: { lon: -116.76793, lat: 33.81106 },
      patchCount: 21,
    },
    {
      id: 6445,
      fileName: "250703_1803.zip",
      biome: "Temperate Broadleaf and Mixed Forests",
      license: "CC BY",
      citationUrl: null,
      thumbnailPath: "6e340ecf-c978-47f2-9448-6a1bc0e08a6e/6445_thumbnail.jpg",
      exportSeed: "1769163187091",
      center: { lon: 128.56302, lat: 36.476 },
      patchCount: 21,
    },
  ],
};

export const benchmarkDatasetCollections = [dteAerialBenchmarkDataset];
