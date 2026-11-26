import type { IGeorefCheck, IGeorefReferenceEvidence } from "../types/georefCheck";

// Readable names for the registry (processor/src/georef_check_v1/providers.json);
// georefCheck.test.ts checks that every registry entry has one.
export const PROVIDER_NAMES: Record<string, string> = {
  maptiler: "MapTiler satellite",
  mapbox: "Mapbox satellite",
  "azure-maps": "Azure Maps imagery",
  "nz-linz-aerial": "LINZ aerial (NZ)",
  "de-bw-dop20": "DOP Baden-Württemberg (DE)",
  "de-by-dop20": "DOP Bavaria (DE)",
  "de-nw-dop10": "DOP North Rhine-Westphalia (DE)",
  "de-th-dop20": "DOP Thuringia (DE)",
  "de-sn-dop20": "DOP Saxony (DE)",
  "de-bebb-dop20": "DOP Brandenburg (DE)",
  "de-be-truedop2024": "TrueDOP Berlin 2024 (DE)",
  "de-ni-dop20": "DOP Lower Saxony (DE)",
  "de-mv-dop20": "DOP Mecklenburg-Vorpommern (DE)",
  "de-st-dop20": "DOP Saxony-Anhalt (DE)",
  "de-he-dop20": "DOP Hesse (DE)",
  "de-sh-dop20": "DOP Schleswig-Holstein (DE)",
  "de-hh-dop": "DOP Hamburg (DE)",
  "de-hb-dop10": "DOP Bremen (DE)",
  "de-rp-dop20": "DOP Rhineland-Palatinate (DE)",
  "de-sl-dop20": "DOP Saarland (DE)",
  "ch-swissimage": "swisstopo SWISSIMAGE",
  "at-basemap-ortho": "basemap.at Orthofoto",
  "fr-ign-bdortho": "IGN BD ORTHO (FR)",
  "es-pnoa-ma": "PNOA (ES)",
  "nl-pdok-ortho-hr": "PDOK luchtfoto (NL)",
  "cz-cuzk-ortofoto": "ČÚZK ortofoto (CZ)",
  "pl-geoportal-orto-std": "Geoportal ortofotomapa (PL)",
  "be-vl-omw": "Flanders orthophoto (BE)",
  "be-wal-ortho-last": "Wallonia orthophoto (BE)",
  "lu-ortho-latest": "Luxembourg orthophoto",
  "ee-maaamet-foto": "Maa- ja Ruumiamet orthophoto (EE)",
  "sk-zbgis-ortofoto": "ZBGIS ortofoto (SK)",
  "si-gurs-dof025": "GURS DOF (SI)",
  "hr-dgu-dof2021_2022": "DGU DOF 2021–22 (HR)",
  "pt-dgt-ortosat2023": "DGT OrtoSat 2023 (PT)",
  "pt-dgt-ortos2021": "DGT orthophoto 2021 (PT)",
  "pt-dgt-ortos2018": "DGT orthophoto 2018 (PT)",
  "it-bz-ortho2023": "South Tyrol orthophoto 2023 (IT)",
  "it-pie-agea2024": "Piedmont AGEA 2024 (IT)",
  "it-tos-ofc2022": "Tuscany orthophoto 2022 (IT)",
  "it-lom-ortofoto2021": "Lombardy orthophoto 2021 (IT)",
  "it-tn-ortho2015": "Trento orthophoto 2015 (IT)",
  "it-pcn-agea2012": "Geoportale Nazionale AGEA 2012 (IT)",
  "us-naip-plus-usgs": "USGS NAIP Plus (US)",
  "us-noaa-west-2023": "NOAA coastal imagery (US)",
  "us-ma-massgis-2025": "MassGIS orthoimagery (US)",
  "us-ny-nysdop-latest": "NYS orthoimagery (US)",
  "ca-on-geoids-2023": "Ontario imagery (CA)",
  "ca-ab-calgary-current": "Calgary orthophoto (CA)",
  "au-qld-latest": "Queensland imagery (AU)",
  "au-nsw-six": "NSW imagery (AU)",
  "au-act-actmapi": "ACTmapi imagery (AU)",
  "au-wa-slip-locate": "Landgate imagery (AU)",
  "jp-gsi-seamlessphoto": "GSI seamless photo (JP)",
  "tw-nlsc-photo2": "NLSC ortho (TW)",
  "br-df-2021": "GeoPortal DF 2021 (BR)",
  "mx-inegi-ortofotos": "INEGI ortofotos (MX)",
  "uy-ide-orto2019": "IDE Uruguay orthophoto 2019",
  "ar-ign-mosaic": "IGN mosaic (AR)",
  "za-ngi-osmza": "NGI aerial (ZA)",
  "za-capetown-2025": "Cape Town aerial 2025 (ZA)",
  "se-lm-minkarta": "Lantmäteriet orthophoto (SE)",
  "gr-ktimatologio": "Ktimatologio orthophoto (GR)",
  "lt-ort10lt": "ORT10LT (LT)",
  "md-ortofoto": "Moldova orthophoto",
  "au-tas-thelist-ortho": "theLIST orthophoto (AU)",
  "au-vic-vicmap-aerial": "Vicmap aerial (AU)",
  "bing-aerial": "Bing aerial",
  "yandex-sat": "Yandex satellite",
  "us-wa-king-2025": "King County imagery (US)",
  "us-ca-santaclara-2025": "Santa Clara County imagery (US)",
  "ca-qc-msp-orthos": "Quebec orthophotos (CA)",
  "ge-napr-ortho": "NAPR orthophoto (GE)",
  "esri-clarity": "Esri World Imagery Clarity",
  "ca-bc-openmaps-1m": "British Columbia orthophoto (CA)",
};

/** Human name of a reference provider, with its capture date where known. */
export function describeReference(check: IGeorefCheck, provider: string): string {
  const captured = check.metadata.references?.[provider]?.capture_date;
  if (provider === "esri") return "Esri World Imagery (current)";
  if (provider.startsWith("wayback-")) return `Esri Wayback${captured ? `, captured ${captured}` : ""}`;
  return PROVIDER_NAMES[provider] ?? provider;
}

/** Tile URL of a viewer template for one XYZ tile: {z}/{x}/{y}, {-y} (TMS row
 * order), {zz} (two-digit zoom) and {q} (Bing quadkey). */
export function fillTileTemplate(template: string, z: number, x: number, y: number): string {
  let quadkey = "";
  for (let i = z; i > 0; i--) quadkey += String(((x >> (i - 1)) & 1) | (((y >> (i - 1)) & 1) << 1));
  return template
    .replace("{-y}", String(2 ** z - 1 - y))
    .replace("{zz}", String(z).padStart(2, "0"))
    .replace("{q}", quadkey)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/** References worth showing first: the ones that measured an offset, then by inliers. */
export function orderedReferences(check: IGeorefCheck): IGeorefReferenceEvidence[] {
  return [...check.reference_evidence].sort((a, b) => Number(b.p90_m !== null) - Number(a.p90_m !== null) || b.inliers - a.inliers);
}

/** Colour of a match by its offset: green well under 15 m, red over. */
export function offsetColor(metres: number): string {
  if (metres < 7.5) return "#2f9e44";
  if (metres < 15) return "#e8a10c";
  return "#d6336c";
}
