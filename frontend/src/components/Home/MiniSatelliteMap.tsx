import { useEffect, useMemo, useRef, useState } from "react";
import { Segmented, Select } from "antd";
import "ol/ol.css";
import { Map, View } from "ol";
import TileLayer from "ol/layer/Tile";
import { XYZ } from "ol/source";
import { GeoTIFF } from "ol/source";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import { fromLonLat } from "ol/proj";

import { getDeadwoodCOGUrl, getForestCOGUrl } from "../../utils/getDeadwoodCOGUrl";
import { getWaybackTileUrl } from "../../utils/waybackVersions";

const LOCATIONS = [
  { name: "Harz Mountains", country: "DE", center: [10.6682, 51.7868], zoom: 12 },
  { name: "Bavarian Forest", country: "DE", center: [13.3309, 49.0396], zoom: 12 },
  { name: "Šumava National Park", country: "CZ", center: [13.45, 48.95], zoom: 12 },
  { name: "Białowieża Forest", country: "PL", center: [23.85, 52.75], zoom: 11 },
];

const YEARS = ["2018", "2020", "2022", "2024"];
const DEFAULT_YEAR = "2024";

const createRasterSource = (url: string) =>
  new GeoTIFF({
    sources: [{ url, bands: [1], min: 0, max: 255 }],
    normalize: true,
    interpolate: false,
  });

const MiniSatelliteMap = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const forestLayerRef = useRef<TileLayerWebGL | null>(null);
  const deadwoodLayerRef = useRef<TileLayerWebGL | null>(null);

  const [activeLocationIndex, setActiveLocationIndex] = useState(0);
  const [activeYear, setActiveYear] = useState(DEFAULT_YEAR);
  const locationOptions = useMemo(
    () => LOCATIONS.map((loc, idx) => ({ label: `${loc.name}, ${loc.country}`, value: idx })),
    [],
  );

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;

      const initialView = new View({
        center: fromLonLat(LOCATIONS[0].center),
        zoom: LOCATIONS[0].zoom,
        enableRotation: false,
      });

      const basemapLayer = new TileLayer({
        source: new XYZ({
          url: getWaybackTileUrl(31144),
          maxZoom: 19,
          crossOrigin: "anonymous",
        }),
      });

      const forestLayer = new TileLayerWebGL({
        source: createRasterSource(getForestCOGUrl(DEFAULT_YEAR)),
        style: {
          color: [
            "interpolate",
            ["linear"],
            ["band", 1],
            0, [144, 238, 144, 0],
            0.1, [144, 238, 144, 0.7],
            0.55, [60, 150, 60, 0.95],
            1, [0, 70, 0, 1],
          ],
        },
      });

      const deadwoodLayer = new TileLayerWebGL({
        source: createRasterSource(getDeadwoodCOGUrl(DEFAULT_YEAR)),
        style: {
          color: [
            "interpolate",
            ["linear"],
            ["band", 1],
            0, [255, 220, 150, 0],
            0.2, [255, 200, 100, 0.1],
            0.5, [255, 179, 28, 0.4],
            0.8, [204, 130, 20, 0.95],
            1, [40, 10, 60, 1],
          ],
        },
      });

      forestLayerRef.current = forestLayer;
      deadwoodLayerRef.current = deadwoodLayer;

      const newMap = new Map({
        target: mapContainer.current,
        layers: [basemapLayer, forestLayer, deadwoodLayer],
        view: initialView,
        controls: [],
        interactions: [], // keep interactions disabled so the user doesn't get stuck panning it while scrolling the page
      });

      mapRef.current = newMap;

    return () => {
      if (mapRef.current) {
        mapRef.current.setTarget(undefined);
        mapRef.current = null;
      }
    };
  }, []);

  // Update center when location changes
  useEffect(() => {
    if (mapRef.current) {
      const loc = LOCATIONS[activeLocationIndex];
      mapRef.current.getView().animate({
        center: fromLonLat(loc.center),
        zoom: loc.zoom,
        duration: 800
      });
    }
  }, [activeLocationIndex]);

  // Update sources when year changes
  useEffect(() => {
    if (forestLayerRef.current && deadwoodLayerRef.current) {
      forestLayerRef.current.setSource(createRasterSource(getForestCOGUrl(activeYear)));
      deadwoodLayerRef.current.setSource(createRasterSource(getDeadwoodCOGUrl(activeYear)));
    }
  }, [activeYear]);

  return (
    <div className="relative h-full w-full">
      <div 
        ref={mapContainer} 
        className="absolute inset-0 h-full w-full pointer-events-none"
      />
      
      {/* Overlay gradient */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/5 to-transparent pointer-events-none"></div>
      
      {/* Controls Container */}
      <div className="absolute inset-0 flex flex-col justify-between p-4 pointer-events-none">
        
        {/* Top Controls */}
        <div className="flex justify-end pointer-events-auto">
          <div className="rounded-lg bg-white/90 p-1 shadow-sm backdrop-blur">
            <Segmented 
              options={YEARS} 
              value={activeYear} 
              onChange={(v) => setActiveYear(v as string)}
              size="small"
            />
          </div>
        </div>

        {/* Bottom Info and Controls */}
        <div className="flex items-end justify-between px-2 pb-2">
          <div className="text-white pointer-events-none drop-shadow-md">
            <div className="font-semibold tracking-wide">LIVE PREVIEW</div>
            <div className="text-sm font-medium opacity-90">{LOCATIONS[activeLocationIndex].name}, {LOCATIONS[activeLocationIndex].country}</div>
          </div>
          
          <div className="pointer-events-auto">
            <div className="rounded-lg bg-white/90 shadow-sm backdrop-blur">
              <Select
                value={activeLocationIndex}
                onChange={setActiveLocationIndex}
                options={locationOptions}
                style={{ width: 180 }}
                size="small"
                variant="borderless"
                dropdownStyle={{ borderRadius: "0.5rem" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MiniSatelliteMap;
