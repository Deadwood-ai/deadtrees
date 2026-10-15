import type {
  IBenchmarkFrame,
  IBenchmarkProduct,
  IBenchmarkSite,
  IBenchmarkSiteSummary,
} from "./types";

export const BENCHMARK_DATA_ROOT = "/disturbance-benchmark/data";
export function contextAttribution(
  frame: IBenchmarkFrame,
  source: string,
): string | undefined {
  return (
    frame.attribution ||
    (source === "planet"
      ? `Imagery © ${frame.date ? `${frame.date.slice(0, 4)} ` : ""}Planet Labs`
      : source === "google"
        ? "Source: Google Earth (historical imagery)"
        : source === "esri"
          ? "Imagery © 2026 Esri and its licensors. All rights reserved"
          : undefined)
  );
}
export function benchmarkAsset(path: string): string {
  return path.startsWith("/data/")
    ? `${BENCHMARK_DATA_ROOT}${path.slice(5)}`
    : path;
}
export function benchmarkDate(value: string): string {
  const monthOnly = /^\d{4}-\d{2}$/.test(value);
  const date = new Date(
    `${monthOnly ? `${value}-01` : value.slice(0, 10)}T12:00:00Z`,
  );
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", {
    ...(monthOnly ? {} : { day: "numeric" }),
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
export function benchmarkTime(date: string): number {
  return new Date(
    `${date.length === 7 ? `${date}-15` : date.slice(0, 10)}T12:00:00Z`,
  ).getTime();
}
const EUROPEAN_COUNTRIES = new Set([
  "Albania",
  "Andorra",
  "Austria",
  "Belarus",
  "Belgium",
  "Bosnia and Herzegovina",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czech Republic",
  "Czechia",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Iceland",
  "Ireland",
  "Italy",
  "Kosovo",
  "Latvia",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Moldova",
  "Monaco",
  "Montenegro",
  "Netherlands",
  "North Macedonia",
  "Norway",
  "Poland",
  "Portugal",
  "Romania",
  "San Marino",
  "Serbia",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
  "Switzerland",
  "Ukraine",
  "United Kingdom",
  "Vatican City",
]);
export function filterBenchmarkSites(
  sites: IBenchmarkSiteSummary[],
  region: string,
): IBenchmarkSiteSummary[] {
  if (region === "tropical")
    return sites.filter((site) => Math.abs(site.center[1]) <= 23.436);
  if (region === "europe")
    return sites.filter(
      (site) =>
        site.continent === "Europe" || EUROPEAN_COUNTRIES.has(site.country),
    );
  return sites;
}
// Shared by comparison cards, gallery navigation and methods; never rank by scores.
const PRODUCT_ORDER = [
  "dte",
  "da",
  "echosat",
  "efda",
  "gfc",
  "lam",
  "radd",
  "tc",
  "tmf",
];
export function orderedBenchmarkProducts(products: IBenchmarkProduct[]) {
  const rank = (id: string) => {
    const index = PRODUCT_ORDER.indexOf(id);
    return index < 0 ? PRODUCT_ORDER.length : index;
  };
  return [...products].sort(
    (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
  );
}
export function availablePredictions(
  site: Pick<IBenchmarkSite, "products">,
  products: IBenchmarkProduct[],
) {
  return orderedBenchmarkProducts(products).flatMap((product) => {
    const evaluation = site.products.find((item) => item.id === product.id);
    return evaluation?.available && evaluation.prediction
      ? [{ product, evaluation }]
      : [];
  });
}
export function initialFrameStart(
  frames: IBenchmarkFrame[],
  droneDate: string,
): number {
  if (frames.length <= 3) return 0;
  const time = benchmarkTime(droneDate);
  const nearest = frames.reduce(
    (best, frame, index) =>
      Math.abs(benchmarkTime(frame.date) - time) <
      Math.abs(benchmarkTime(frames[best].date) - time)
        ? index
        : best,
    0,
  );
  return Math.max(0, Math.min(frames.length - 3, nearest - 1));
}
