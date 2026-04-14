import { createContext, useContext, useState, ReactNode } from "react";

interface DownloadProviderProps {
  children: ReactNode;
}

type DownloadContextType = {
  isDownloading: boolean;
  currentDownloadId: string | null;
  startDownload: (datasetId: string) => boolean;
  finishDownload: () => void;
};

const DownloadContext = createContext<DownloadContextType>({
  isDownloading: false,
  currentDownloadId: null,
  startDownload: () => false,
  finishDownload: () => {},
});

const DownloadProvider = ({ children }: DownloadProviderProps) => {
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [currentDownloadId, setCurrentDownloadId] = useState<string | null>(null);

  const startDownload = (datasetId: string): boolean => {
    if (isDownloading) {
      return false; // Download already in progress
    }

    setIsDownloading(true);
    setCurrentDownloadId(datasetId);
    return true;
  };

  const finishDownload = () => {
    setIsDownloading(false);
    setCurrentDownloadId(null);
  };

  const value = {
    isDownloading,
    currentDownloadId,
    startDownload,
    finishDownload,
  };

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
};

export const useDownload = () => useContext(DownloadContext);

export default DownloadProvider;
