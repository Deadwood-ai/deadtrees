import React, { createContext, useState, useContext } from "react";
import { transform } from "ol/proj";
interface MapViewportContextType {
  DatasetViewport: { center: number[]; zoom: number };
  setDatasetViewport: (view: { center: number[]; zoom: number }) => void;
  DeadwoodMapViewport: { center: number[]; zoom: number };
  setDeadwoodMapViewport: (view: { center: number[]; zoom: number }) => void;
  DeadwoodMapStyle: string;
  setDeadwoodMapStyle: (style: string) => void;
}

const MapViewportContext = createContext<MapViewportContextType>({
  DatasetViewport: { center: [0, 0], zoom: 2 },
  setDatasetViewport: () => {},
  DeadwoodMapViewport: { center: [0, 0], zoom: 6 },
  setDeadwoodMapViewport: () => {},
  DeadwoodMapStyle: "wayback",
  setDeadwoodMapStyle: () => {},
});

const DatasetMapProvider = (props: { children: React.ReactNode }) => {
  const [DatasetViewport, setDatasetViewport] = useState({ center: [0, 0], zoom: 2 });
  // center of germany in  epsg:3857
  const center = transform([10.451526, 51.165691], "EPSG:4326", "EPSG:3857");
  const [DeadwoodMapViewport, setDeadwoodMapViewport] = useState({ center: center, zoom: 6 });
  const [DeadwoodMapStyle, setDeadwoodMapStyle] = useState("wayback");
  return (
    <MapViewportContext.Provider
      value={{
        DatasetViewport,
        setDatasetViewport,
        DeadwoodMapViewport,
        setDeadwoodMapViewport,
        DeadwoodMapStyle,
        setDeadwoodMapStyle,
      }}
    >
      {props.children}
    </MapViewportContext.Provider>
  );
};

export const useDatasetMap = () => {
  return useContext(MapViewportContext);
};

export default DatasetMapProvider;
