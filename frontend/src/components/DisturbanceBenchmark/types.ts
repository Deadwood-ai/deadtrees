export interface IBenchmarkProduct {
  id: string;
  name: string;
  color: string;
  resolution: string;
  definition: string;
}
export interface IBenchmarkSiteSummary {
  id: string;
  name: string;
  country: string;
  continent?: string;
  catalogueStatus?: string;
  type: string;
  year: number;
  center: [number, number];
  thumbnail: string;
  droneDate: string;
  droneDateLabel?: string;
  areaHa: number;
  detail: string;
  datasetUrl?: string;
}
export interface IBenchmarkEvaluation {
  id: string;
  available: boolean;
  prediction?: string;
  reason?: string;
  source?: string;
  metricNote?: string;
  counts?: { tp: number; fp: number; fn: number; tn: number };
  layers?: {
    image: string;
    label: string;
    minimum: number;
    maximum: number;
    source: string;
    band: number;
  }[];
}
export type BenchmarkIndex = "ndvi" | "ndii" | "evi" | "kndvi";
export type ContextSource = "planet" | "google" | "esri";
export interface IBenchmarkObservation {
  date: string;
  ndvi: number | null;
  ndii: number | null;
  evi: number | null;
  kndvi: number | null;
}
export interface IBenchmarkPlanetObservation {
  date: string;
  gcc: number | null;
  validPixels?: number;
  frameImage?: string;
}
export interface IBenchmarkFrame {
  displayDate?: string;
  compositeType?: string;
  attribution?: string;
  date: string;
  image: string;
  /** Smaller copy for tiles and strips, written by the publish script for heavy images. */
  preview?: string;
  source: string;
  gcc?: number | null;
  referencePolygons?: IReferencePolygons;
}
export interface IReferencePolygons {
  type: "FeatureCollection";
  features: {
    geometry: {
      type: "Polygon" | "MultiPolygon";
      coordinates: number[][][] | number[][][][];
    };
  }[];
}
export interface IBenchmarkSite extends IBenchmarkSiteSummary {
  dataWarnings?: string[];
  drone: string;
  dronePreview?: string;
  reference: string;
  referenceBinary?: string;
  referencePolygons?: IReferencePolygons;
  width: number;
  height: number;
  crs: string;
  previewResolution: number;
  droneValidFraction?: number;
  displayDroneAreaHa?: number;
  displayDisturbedAreaHa?: number;
  products: IBenchmarkEvaluation[];
  series: IBenchmarkObservation[];
  planetSeries?: IBenchmarkPlanetObservation[];
  contexts: Partial<Record<ContextSource, IBenchmarkFrame[]>>;
  notes: string[];
  datasetUrl?: string;
  provenance: {
    imageryVersion: string;
    evaluationVersion: string;
    window: string;
    threshold: number | null;
  };
}
export interface IBenchmarkCatalog {
  sites: IBenchmarkSiteSummary[];
  products: IBenchmarkProduct[];
  notes?: string[];
}
