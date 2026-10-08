"""Bounded zoom tool for Sol: native-resolution crops of the original COG with both overlays.

Sol names a rectangle inside a delivered view (O, G1..G9, N1..N4) in that view's pixels;
the tool reads that window from the public COG at up to 1024 px (never upsampled) and
returns raw | deadwood | forest. Reuses the benchmark renderer's reader and rasterizer.
"""
import base64
import io
import json
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
import rasterio
from rasterio.features import rasterize
from rasterio.warp import transform_geom
from rasterio.windows import Window

from render_benchmark import COG_ROOT, COLORS, LAYERS, fetch, read, rgba

TOOL = {
    'name': 'zoom',
    'description': ('Inspect any rectangle of a delivered view at up to native resolution. Coordinates are pixels '
                    'of that view image. Returns raw RGB, deadwood overlay and forest overlay side by side. '
                    'Use it to check suspected errors and predicted-negative areas before deciding.'),
    'inputSchema': {'type': 'object', 'additionalProperties': False,
                    'required': ['view', 'x0', 'y0', 'x1', 'y1', 'purpose'],
                    'properties': {'view': {'type': 'string', 'description': 'O, G1..G9 or N1..N4'},
                                   'x0': {'type': 'integer'}, 'y0': {'type': 'integer'},
                                   'x1': {'type': 'integer'}, 'y1': {'type': 'integer'},
                                   'purpose': {'type': 'string'}}},
}


class Zoom:
    tool = TOOL
    enabled = True

    def __init__(self, root, dataset, out, budget=4):
        self.dataset, self.out, self.budget, self.calls = dataset, Path(out), budget, []
        evidence = json.loads((Path(root) / 'datasets' / str(dataset['dataset_id']) / 'evidence.json').read_text())
        self.views = {('O' if v['name'] == 'overview' else v['name'].upper()): v for v in evidence['views']}
        cog, aoi, geometries = fetch(dataset)
        self.url = COG_ROOT + quote(cog['cog_path'], safe='/')
        self.aoi, self.geometries, self.src = aoi, geometries, None

    def open(self):
        if self.src is None:
            self.env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60',
                                    GDAL_HTTP_MAX_RETRY='2', GDAL_CACHEMAX=128)
            self.env.__enter__()
            self.src = rasterio.open(self.url)
            self.aoi_src = transform_geom(4326, self.src.crs, self.aoi)
            self.shapes = {l: [transform_geom(4326, self.src.crs, g) for g in self.geometries[l]] for l in LAYERS}
        return self.src

    def close(self):
        if self.src is not None:
            self.src.close()
            self.env.__exit__(None, None, None)

    def inspect(self, value):
        if len(self.calls) >= self.budget:
            raise ValueError(f'Zoom budget of {self.budget} used; decide with the evidence you have')
        view = self.views.get(str(value.get('view', '')).upper().removeprefix('O-').split('-')[0] or 'O')
        if view is None:
            raise ValueError('Unknown view; use O, G1..G9 or N1..N4')
        x0, y0, x1, y1 = (int(value[k]) for k in ('x0', 'y0', 'x1', 'y1'))
        w, h = view['size']
        x0, x1 = sorted((max(0, min(w, x0)), max(0, min(w, x1))))
        y0, y1 = sorted((max(0, min(h, y0)), max(0, min(h, y1))))
        if x1 - x0 < 4 or y1 - y0 < 4:
            raise ValueError('Rectangle too small or outside the view')
        col, row, ww, wh = view['window']
        sx, sy = ww / w, wh / h
        src = self.open()
        window = Window(col + x0 * sx, row + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy)
        rgb, valid, affine = read(src, window, 1024)
        inside = rasterize([(self.aoi_src, 1)], out_shape=valid.shape, transform=affine, dtype='uint8') > 0
        support = valid & inside
        raw = Image.fromarray(np.where(support[..., None], rgb, (rgb * .35).astype('uint8')))
        panels = [raw]
        for layer in LAYERS:
            mask = (rasterize([(g, 1) for g in self.shapes[layer]], out_shape=valid.shape, transform=affine,
                              dtype='uint8') > 0 if self.shapes[layer] else np.zeros(valid.shape, bool)) & support
            panel = raw.convert('RGBA')
            fill = rgba(mask, COLORS[layer], False)
            fill.putalpha(fill.getchannel('A').point(lambda v: round(v * .3)))
            panel.alpha_composite(fill)
            panel.alpha_composite(rgba(mask, COLORS[layer], True))
            panels.append(panel.convert('RGB'))
        sheet = Image.new('RGB', (sum(p.width for p in panels) + 16, panels[0].height), (255, 255, 255))
        for i, p in enumerate(panels):
            sheet.paste(p, (i * (p.width + 8), 0))
        stream = io.BytesIO()
        sheet.save(stream, 'JPEG', quality=90, subsampling=0)
        data = stream.getvalue()
        name = f'Z{len(self.calls) + 1}'
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / f'{name}.jpg').write_bytes(data)
        scale = round(view['mpp'] * 100 * (x1 - x0) / rgb.shape[1], 1)
        self.calls.append({'name': name, 'view': value.get('view'), 'rect': [x0, y0, x1, y1],
                           'purpose': str(value.get('purpose', ''))[:200], 'cm_per_px': scale})
        return [{'type': 'inputText', 'text': f'{name}: {value.get("view")} [{x0},{y0},{x1},{y1}] at about '
                                              f'{scale} cm/px, raw | deadwood | forest'},
                {'type': 'inputImage', 'imageUrl': 'data:image/jpeg;base64,' + base64.b64encode(data).decode()}]
