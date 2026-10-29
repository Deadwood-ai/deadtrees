import { createContext, useContext, useMemo } from "react";
import { useAuthors } from "./useDatasets";
import { useLocation } from "react-router-dom";

interface DataProviderProps {
  children: React.ReactNode;
}

interface AuthorOption {
  label: string;
  value: string;
}

type DataContextType = {
  authors: AuthorOption[] | undefined;
};

const DataContext = createContext<DataContextType>({
  authors: undefined,
});

const DataProvider = ({ children }: DataProviderProps) => {
  const location = useLocation();
  const shouldFetchAuthors = useMemo(() => {
    const pathname = location.pathname;
    // About, account and archive pages offer the author list (credits, upload and edit forms, filters).
    // Authors come from the narrow archive read model; never prefetch the full public dataset view here,
    // it times out for anonymous visitors.
    if (pathname === "/about") return true;
    if (pathname.startsWith("/profile")) return true;
    if (pathname === "/dataset") return true;
    return false;
  }, [location.pathname]);

  const { data: authors } = useAuthors({ enabled: shouldFetchAuthors });

  const value = useMemo(() => ({ authors }), [authors]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useData = () => useContext(DataContext);

export default DataProvider;
