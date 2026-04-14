import React, { createContext, useState, useContext, ReactNode } from "react";

type AOIContextType = {
  currentAOI: GeoJSON.MultiPolygon | null;
  setCurrentAOI: (aoi: GeoJSON.MultiPolygon | null) => void;
  datasetId: number | null;
  setDatasetId: (id: number | null) => void;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (hasChanges: boolean) => void;
};

const defaultContext: AOIContextType = {
  currentAOI: null,
  setCurrentAOI: () => {},
  datasetId: null,
  setDatasetId: () => {},
  hasUnsavedChanges: false,
  setHasUnsavedChanges: () => {},
};

export const AOIContext = createContext<AOIContextType>(defaultContext);

interface AOIProviderProps {
  children: ReactNode;
}

export const AOIProvider: React.FC<AOIProviderProps> = ({ children }) => {
  const [currentAOI, setCurrentAOI] = useState<GeoJSON.MultiPolygon | null>(null);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);

  return (
    <AOIContext.Provider
      value={{
        currentAOI,
        setCurrentAOI,
        datasetId,
        setDatasetId,
        hasUnsavedChanges,
        setHasUnsavedChanges,
      }}
    >
      {children}
    </AOIContext.Provider>
  );
};

export const useAOI = () => useContext(AOIContext);
