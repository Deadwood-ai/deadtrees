/** The few things an auditor reads off an orthophoto's technical metadata (v2_orthos.ortho_info,
 * as rio-cogeo reports it). Every fact is optional: older rows lack some keys. */
export interface IImageFact {
  label: string;
  value: string;
  /** a problem worth a second look, e.g. an invalid COG */
  tone?: "ok" | "warn";
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const count = (n: number) => n.toLocaleString("en-US");

const BIT_DEPTHS: Record<string, string> = { uint8: "8 bit", uint16: "16 bit", int16: "16 bit", float32: "32 bit float" };

/** The name in a WKT string's first node, e.g. "WGS 84 / UTM zone 32N". */
function crsName(wkt: unknown): string | null {
  const match = typeof wkt === "string" ? /^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\["([^"]+)"/.exec(wkt) : null;
  return match ? match[2] : null;
}

export function imageFacts(orthoInfo: unknown): IImageFact[] {
  const info = record(orthoInfo);
  const profile = record(info.Profile);
  const geo = record(info.GEO);
  const facts: IImageFact[] = [];

  const { Width: width, Height: height } = profile;
  if (typeof width === "number" && typeof height === "number") facts.push({ label: "Size", value: `${count(width)} × ${count(height)} px` });

  // the pixel size is in the units of the projection: metres for a projected one, degrees otherwise
  const pixel = list(geo.Resolution)[0];
  const projected = typeof geo.CRS === "string" && /^\s*PROJC(S|RS)\[/.test(geo.CRS);
  if (typeof pixel === "number" && projected) {
    const cm = Math.abs(pixel) * 100;
    facts.push({ label: "Resolution", value: `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm per pixel` });
  }

  const bands = list(profile.ColorInterp).filter((b): b is string => typeof b === "string");
  const depth = typeof profile.Dtype === "string" ? (BIT_DEPTHS[profile.Dtype] ?? profile.Dtype) : null;
  const named = bands.join(", ") || (typeof profile.Bands === "number" ? `${profile.Bands} bands` : null);
  if (named || depth) facts.push({ label: "Bands", value: [named, depth].filter(Boolean).join(" · ") });

  const errors = list(info.COG_errors).map(String);
  const warnings = list(info.COG_warnings).map(String);
  if (typeof info.COG === "boolean") {
    const valid = info.COG && !errors.length;
    const parts = [valid ? "Valid COG" : "Not a valid COG", typeof info.Compression === "string" ? info.Compression : null, profile.Tiled === true ? "tiled" : null];
    facts.push({ label: "File", value: parts.filter(Boolean).join(" · "), tone: valid ? "ok" : "warn" });
  }
  for (const problem of [...errors, ...warnings]) facts.push({ label: "Note", value: problem, tone: "warn" });

  const name = crsName(geo.CRS);
  if (name) facts.push({ label: "Projection", value: name });
  return facts;
}
