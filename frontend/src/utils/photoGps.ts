// Whether a drone photo carries a GPS position, read the way ODM reads it.
// Mirrors `shared/photo_gps.py`; both are tested against
// `test/fixtures/photo-gps/manifest.json`, so keep them in step. ODM places a
// photo by its EXIF GPS tags or DJI's XMP drone-dji:Latitude/Longitude.
//
// Answers true (has a position), false (metadata read, no position) or null
// (could not read it). Only false counts against an upload. This reader knows
// JPEG and TIFF-based files (TIFF, DNG); any other format answers null, so the
// browser never rejects what the server would accept.

const GPS_IFD = 0x8825;
const GPS_LATITUDE = 2;
const GPS_LONGITUDE = 4;
// DJI writes its XMP packet near the start of the JPEG.
const XMP_SCAN_BYTES = 2 * 1024 * 1024;
const XMP_LATITUDE = /drone-dji:Latitude\s*=\s*["']\s*[+-]?[\d.]+|<drone-dji:Latitude>\s*[+-]?[\d.]+/;
const XMP_LONGITUDE = /drone-dji:Longitude\s*=\s*["']\s*[+-]?[\d.]+|<drone-dji:Longitude>\s*[+-]?[\d.]+/;

const hasXmpPosition = (bytes: Uint8Array): boolean => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, XMP_SCAN_BYTES));
  return XMP_LATITUDE.test(head) && XMP_LONGITUDE.test(head);
};

/** GPS answer for a TIFF structure (a TIFF file or a JPEG's Exif block). */
const tiffGps = (tiff: Uint8Array): boolean | null => {
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  // Tags of the IFD at `offset`, or null when it lies outside the bytes read.
  const tags = (offset: number): Map<number, number> | null => {
    if (offset + 2 > tiff.length) return null;
    const count = u16(offset);
    if (offset + 2 + count * 12 > tiff.length) return null;
    const found = new Map<number, number>();
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      found.set(u16(entry), u32(entry + 8));
    }
    return found;
  };

  const ifd0 = tags(u32(4));
  if (!ifd0) return null;
  const gpsOffset = ifd0.get(GPS_IFD);
  if (gpsOffset === undefined) return false;
  const gps = tags(gpsOffset);
  if (!gps) return null;
  // A GPS block without both coordinates is how cameras record "no fix".
  return gps.has(GPS_LATITUDE) && gps.has(GPS_LONGITUDE);
};

/** GPS answer for a JPEG: its first Exif block decides; no Exif block means no position. */
const jpegGps = (bytes: Uint8Array): boolean | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Start of scan or end of image: the metadata segments are over.
    if (marker === 0xda || marker === 0xd9) return false;
    const length = view.getUint16(at + 2);
    const isExif =
      marker === 0xe1 &&
      new TextDecoder("latin1").decode(bytes.subarray(at + 4, at + 10)) === "Exif\0\0";
    if (isExif) return tiffGps(bytes.subarray(at + 10, at + 2 + length));
    at += 2 + length;
  }
  return null;
};

export const hasGpsPosition = (bytes: Uint8Array): boolean | null => {
  if (hasXmpPosition(bytes)) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegGps(bytes);
  return tiffGps(bytes);
};
