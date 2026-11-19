"""Writes the photo GPS fixtures shared by shared/tests and frontend tests (DT-1582).

Run from the repository root: python frontend/test/fixtures/photo-gps/make_fixtures.py frontend/test/fixtures/photo-gps
"""
import io, json, struct, sys, zipfile
from pathlib import Path
from PIL import Image
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)

def dms(v):
    v = abs(v); d = int(v); m = int((v - d) * 60); s = (v - d - m / 60) * 3600
    return d, m, s

def jpeg(exif=None, extra=b''):
    buf = io.BytesIO()
    kwargs = {'exif': exif} if exif is not None else {}
    Image.new('RGB', (8, 8), (40, 120, 40)).save(buf, 'JPEG', **kwargs)
    return buf.getvalue() + extra

def gps_exif(lat=48.0, lon=7.85, fix=True):
    exif = Image.Exif(); exif[0x010F] = 'DJI'
    gps = exif.get_ifd(0x8825)
    gps[0] = b'\x02\x03\x00\x00'
    if fix:
        gps.update({1: 'N', 2: dms(lat), 3: 'E', 4: dms(lon)})
    return exif

def tiff(endian='<', gps=None, ifd_at_end=True, truncate=False):
    """A 4x4 RGB TIFF written by hand so the IFD position and byte order are explicit."""
    w = h = 4; pixels = bytes(w * h * 3)
    def entries(strip_offset, gps_offset):
        e = [(256, 3, 1, w), (257, 3, 1, h), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 2),
             (273, 4, 1, strip_offset), (277, 3, 1, 3), (278, 3, 1, h), (279, 4, 1, len(pixels))]
        if gps_offset is not None:
            e.append((0x8825, 4, 1, gps_offset))
        return sorted(e)
    def pack_ifd(es, values_blob_offset=0):
        b = struct.pack(endian + 'H', len(es))
        for tag, typ, count, value in es:
            if typ == 3:
                b += struct.pack(endian + 'HHIHH', tag, typ, count, value, 0)
            else:
                b += struct.pack(endian + 'HHII', tag, typ, count, value)
        return b + struct.pack(endian + 'I', 0)
    def gps_ifd(offset):
        # GPS IFD: ref tags inline (ASCII 2), lat/lon as 3 RATIONALs stored after the IFD.
        lat, lon = gps
        n = 4; ifd_len = 2 + 12 * n + 4; values = offset + ifd_len
        def rationals(v):
            d, m, s = dms(v)
            return struct.pack(endian + '6I', d, 1, m, 1, int(s * 1000), 1000)
        b = struct.pack(endian + 'H', n)
        b += struct.pack(endian + 'HHI', 1, 2, 2) + (b'S' if lat < 0 else b'N') + b'\x00\x00\x00'
        b += struct.pack(endian + 'HHII', 2, 5, 3, values)
        b += struct.pack(endian + 'HHI', 3, 2, 2) + (b'W' if lon < 0 else b'E') + b'\x00\x00\x00'
        b += struct.pack(endian + 'HHII', 4, 5, 3, values + 24)
        b += struct.pack(endian + 'I', 0)
        return b + rationals(lat) + rationals(lon)
    magic = b'II*\x00' if endian == '<' else b'MM\x00*'
    n_entries = 9 + (gps is not None)
    ifd_len = 2 + 12 * n_entries + 4
    if ifd_at_end:
        strip = 8; ifd0 = 8 + len(pixels); gps_off = ifd0 + ifd_len if gps else None
        body = pixels + pack_ifd(entries(strip, gps_off)) + (gps_ifd(gps_off) if gps else b'')
    else:
        ifd0 = 8; gps_off = 8 + ifd_len if gps else None
        gps_blob = gps_ifd(gps_off) if gps else b''
        strip = 8 + ifd_len + len(gps_blob)
        body = pack_ifd(entries(strip, gps_off)) + gps_blob + pixels
    data = magic + struct.pack(endian + 'I', ifd0) + body
    return data[: 8 + len(pixels) // 2] if truncate else data

xmp = b'<x:xmpmeta><rdf:Description drone-dji:Latitude="+48.000000" drone-dji:Longitude="+7.850000"/></x:xmpmeta>'
no_gps_exif = Image.Exif(); no_gps_exif[0x010F] = 'Phone'
cases = {
    'gps.jpg': (jpeg(gps_exif()), True, 'EXIF GPS position'),
    'dji-xmp-only.jpg': (jpeg(extra=xmp), True, 'DJI XMP position, no EXIF GPS (ODM reads XMP)'),
    'no-exif.jpg': (jpeg(), False, 'JPEG without any metadata'),
    'exif-without-gps.jpg': (jpeg(no_gps_exif), False, 'EXIF camera tags but no GPS block'),
    'gps-block-without-fix.jpg': (jpeg(gps_exif(fix=False)), False, 'GPS block with only its version tag: no fix'),
    'gps-ifd-first.tif': (tiff(gps=(48.0, 7.85), ifd_at_end=False), True, 'little-endian TIFF, metadata before pixels'),
    'gps-big-endian.tif': (tiff('>', gps=(-33.5, -70.25)), True, 'big-endian TIFF with GPS, metadata after pixels'),
    'no-gps-metadata-at-end.tif': (tiff(), False, 'TIFF without GPS whose metadata follows the pixels (like dataset 15632)'),
    'truncated.tif': (tiff(truncate=True), None, 'TIFF cut before its metadata: unknown, never a rejection'),
    'gps-block-cut-off.tif': (tiff(gps=(48.0, 7.85), ifd_at_end=False)[:134], None, 'TIFF whose GPS block points past the end: unknown, not "no GPS"'),
    'not-a-photo.jpg': (b'this is not an image', None, 'unreadable bytes: unknown'),
}
manifest = {'cases': []}
for name, (data, expected, note) in cases.items():
    (out / name).write_bytes(data)
    manifest['cases'].append({'file': name, 'has_gps': expected, 'note': note})
def write_zip(name, members):
    with zipfile.ZipFile(out / name, 'w', zipfile.ZIP_DEFLATED) as z:
        for member, data in members:
            z.writestr(member, data)
write_zip('no-gps-flight.zip', [(f'flight/IMG_{i:04d}.JPG', jpeg()) for i in range(12)])
write_zip('gps-flight.zip', [(f'flight/DJI_{i:04d}.JPG', jpeg() if i < 3 else jpeg(gps_exif(48.0 + i * 1e-4))) for i in range(12)])
manifest['zips'] = [
    {'file': 'no-gps-flight.zip', 'outcome': 'reject', 'note': '12 photos, none with a GPS position'},
    {'file': 'gps-flight.zip', 'outcome': 'accept', 'note': 'first 3 photos lack a fix, the rest have GPS'},
]
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('\n'.join(f'{p.name} {p.stat().st_size}' for p in sorted(out.iterdir())))
