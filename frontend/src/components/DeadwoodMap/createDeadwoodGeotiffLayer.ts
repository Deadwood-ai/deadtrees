import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";
import getDeadwoodCOGUrl from "../../utils/getDeadwoodCOGUrl";

const createDeadwoodGeotiffLayer = (year: string) => {
  const source = new GeoTIFF({
    sources: [
      {
        url: getDeadwoodCOGUrl(year),
        bands: [1],
        min: 0,
        max: 255,
      },
    ],
    normalize: true,
    interpolate: false, // Show actual pixel grid
  });

  // Single-band COG: values 0-255 (normalized to 0-1)
  // Low values = no deadwood (transparent), high values = deadwood (red)
  const layer = new TileLayerWebGL({
    source,
    className: "geotiff-layer" + year,
    opacity: 0,
    style: {
      color: [
        "interpolate",
        ["linear"],
        ["band", 1],
        0,
        [255, 0, 0, 0], // 0: fully transparent
        0.04,
        [255, 0, 0, 0], // ~5/138: still transparent (noise threshold)
        0.15,
        [255, 0, 0, 0.15], // ~10/138: start showing red
        0.25,
        [255, 0, 0, 0.25], // ~35/138: medium opacity
        0.5,
        [255, 0, 0, 0.5], // ~69/138: high opacity
        0.75,
        [255, 0, 0, 0.75],
        1,
        [255, 0, 0, 1], // 138/138: solid red
      ],
    },
    visible: year === "2025",
  });

  layer.cleanup = () => {
    source.clear();
    source.dispose();
    layer.dispose();
  };

  return layer;
};

export default createDeadwoodGeotiffLayer;
