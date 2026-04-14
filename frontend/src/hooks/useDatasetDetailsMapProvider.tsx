import React, { createContext, useState, useContext, useMemo, useCallback } from "react";

// Navigation source type
export type NavigationSource = "dataset" | "navigation" | null;

// Layer control state interface
interface LayerControlState {
  mapStyle: string;
  showForestCover: boolean;
  showDeadwood: boolean;
  showDroneImagery: boolean;
  showAOI: boolean;
  layerOpacity: number;
}

interface DatasetDetailsMapContextType {
  // Viewport state
  viewport: {
    center: number[];
    zoom: number;
    extent?: number[];
  };
  navigatedFrom: NavigationSource;
  setViewport: (view: { center: number[]; zoom: number; extent?: number[] }) => void;
  setNavigationSource: (source: NavigationSource) => void;

  // Layer control state
  layerControl: LayerControlState;
  setMapStyle: (style: string) => void;
  setShowForestCover: (show: boolean) => void;
  setShowDeadwood: (show: boolean) => void;
  setShowDroneImagery: (show: boolean) => void;
  setShowAOI: (show: boolean) => void;
  setLayerOpacity: (opacity: number) => void;
}

const defaultLayerControl: LayerControlState = {
  mapStyle: "streets-v12",
  showForestCover: true,
  showDeadwood: true,
  showDroneImagery: true,
  showAOI: true,
  layerOpacity: 1,
};

const DatasetDetailsMapContext = createContext<DatasetDetailsMapContextType>({
  viewport: {
    center: [0, 0],
    zoom: 2,
  },
  navigatedFrom: null,
  setViewport: () => { },
  setNavigationSource: () => { },
  layerControl: defaultLayerControl,
  setMapStyle: () => { },
  setShowForestCover: () => { },
  setShowDeadwood: () => { },
  setShowDroneImagery: () => { },
  setShowAOI: () => { },
  setLayerOpacity: () => { },
});

export const DatasetDetailsMapProvider = (props: { children: React.ReactNode }) => {
  // Viewport state
  const [viewport, setViewport] = useState({
    center: [0, 0],
    zoom: 2,
  });
  const [navigatedFrom, setNavigationSource] = useState<NavigationSource>(null);

  // Layer control state
  const [layerControl, setLayerControl] = useState<LayerControlState>(defaultLayerControl);

  // Individual setters for layer control (to avoid full re-renders when only one value changes)
  const setMapStyle = useCallback((style: string) => {
    setLayerControl((prev) => ({ ...prev, mapStyle: style }));
  }, []);

  const setShowForestCover = useCallback((show: boolean) => {
    setLayerControl((prev) => ({ ...prev, showForestCover: show }));
  }, []);

  const setShowDeadwood = useCallback((show: boolean) => {
    setLayerControl((prev) => ({ ...prev, showDeadwood: show }));
  }, []);

  const setShowDroneImagery = useCallback((show: boolean) => {
    setLayerControl((prev) => ({ ...prev, showDroneImagery: show }));
  }, []);

  const setShowAOI = useCallback((show: boolean) => {
    setLayerControl((prev) => ({ ...prev, showAOI: show }));
  }, []);

  const setLayerOpacity = useCallback((opacity: number) => {
    setLayerControl((prev) => ({ ...prev, layerOpacity: opacity }));
  }, []);

  // Memoize the context value to prevent unnecessary rerenders
  const contextValue = useMemo(
    () => ({
      viewport,
      navigatedFrom,
      setViewport,
      setNavigationSource,
      layerControl,
      setMapStyle,
      setShowForestCover,
      setShowDeadwood,
      setShowDroneImagery,
      setShowAOI,
      setLayerOpacity,
    }),
    [viewport, navigatedFrom, layerControl, setMapStyle, setShowForestCover, setShowDeadwood, setShowDroneImagery, setShowAOI, setLayerOpacity],
  );

  return <DatasetDetailsMapContext.Provider value={contextValue}>{props.children}</DatasetDetailsMapContext.Provider>;
};

export const useDatasetDetailsMap = () => {
  return useContext(DatasetDetailsMapContext);
};

export default DatasetDetailsMapProvider;
