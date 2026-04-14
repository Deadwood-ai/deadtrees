type LegacyMapboxMap = {
  addSource: (id: string, source: unknown) => void;
  addLayer: (layer: unknown) => void;
};

const addDeadwoodWMSLayers = (map: LegacyMapboxMap) => {
  const baseURL =
    "https://data.waldklick.de/geoserver/waldklick/wms?&service=WMS&request=GetMap&format=image/png&version=1.1.1&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&width=256&HEIGHT=256&transparent=true&authkey=eedde8df-05df-48c5-864e-c571ba188f64";
  const wmsURL2021 = `${baseURL}&layers=waldklick:deadwood-de-2021`;
  const wmsURL2020 = `${baseURL}&layers=waldklick:deadwood-de-2020`;
  const wmsURL2019 = `${baseURL}&layers=waldklick:deadwood-de-2019`;
  const wmsURL2018 = `${baseURL}&layers=waldklick:deadwood-de-2018`;
  map.addSource("deadtrees_2018", {
    type: "raster",
    tiles: [wmsURL2018],
    tileSize: 256,
  });
  map.addLayer({
    id: "deadtrees_2018_layer",
    type: "raster",
    source: "deadtrees_2018",
  });
  map.addSource("deadtrees_2019", {
    type: "raster",
    tiles: [wmsURL2019],
    tileSize: 256,
  });
  map.addLayer({
    id: "deadtrees_2019_layer",
    type: "raster",
    source: "deadtrees_2019",
    layout: {
      visibility: "none",
    },
  });
  map.addSource("deadtrees_2020", {
    type: "raster",
    tiles: [wmsURL2020],
    tileSize: 256,
  });
  map.addLayer({
    id: "deadtrees_2020_layer",
    type: "raster",
    source: "deadtrees_2020",
    layout: {
      visibility: "none",
    },
  });
  map.addSource("deadtrees_2021", {
    type: "raster",
    tiles: [wmsURL2021],
    tileSize: 256,
  });
  map.addLayer({
    id: "deadtrees_2021_layer",
    type: "raster",
    source: "deadtrees_2021",
    layout: {
      visibility: "none",
    },
  });
};

export default addDeadwoodWMSLayers;
