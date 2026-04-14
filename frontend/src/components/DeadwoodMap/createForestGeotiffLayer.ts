import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { GeoTIFF } from "ol/source";
import { getForestCOGUrl } from "../../utils/getDeadwoodCOGUrl";

const createForestGeotiffLayer = (year: string) => {
  const source = new GeoTIFF({
    sources: [
      {
        url: getForestCOGUrl(year),
        bands: [1],
        min: 0,
        max: 255, // Values 0-255 scaled to 0-100%
      },
    ],
    normalize: true,
    interpolate: false, // Show actual pixel grid
  });

  // Single-band COG: values 0-255 (normalized to 0-1)
  // Low values = no forest (transparent), high values = forest (green)
  const layer = new TileLayerWebGL({
    source,
    className: "forest-layer-" + year,
    opacity: 0,
    style: {
      color: [
        "interpolate",
        ["linear"],
        ["band", 1],
        0,
        [34, 139, 34, 0], // 0: fully transparent
        0.15,
        [34, 139, 34, 0.1], // 10%: light green, low opacity
        0.3,
        [34, 139, 34, 0.3], // 30%: medium green
        0.5,
        [34, 139, 34, 0.5], // 50%: stronger green
        0.7,
        [34, 139, 34, 0.7], // 70%: dark green
        1,
        [0, 100, 0, 0.9], // 100%: dark forest green, solid
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

export default createForestGeotiffLayer;
