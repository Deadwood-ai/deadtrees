import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import AuthProvider from "./hooks/useAuthProvider";
import DataProvider from "./hooks/useDataProvider";
import DatasetMapProvider from "./hooks/useDatasetMapProvider";
import DatasetDetailsMapProvider from "./hooks/useDatasetDetailsMapProvider";
import { DatasetFilterProvider } from "./hooks/useDatasetFilterProvider";
import DownloadProvider from "./hooks/useDownloadProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CookieBanner } from "./components/cookieBanner/CookieBanner";
import { applyCanvasOptimization } from "./utils/canvasOptimization";
import { applyThemeCssVariables } from "./theme/cssVariables";
import { BrowserRouter } from "react-router-dom";

applyThemeCssVariables();
applyCanvasOptimization();

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthProvider>
        <DataProvider>
          <DatasetMapProvider>
            <DatasetDetailsMapProvider>
              <DatasetFilterProvider>
                <DownloadProvider>
                  <App />
                  <CookieBanner />
                </DownloadProvider>
              </DatasetFilterProvider>
            </DatasetDetailsMapProvider>
          </DatasetMapProvider>
        </DataProvider>
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);
