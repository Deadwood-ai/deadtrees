import { Outlet, Route, Routes, useLocation } from "react-router-dom";
import { App as AntdApp, ConfigProvider, Layout, Spin } from "antd";
import { lazy, Suspense, useEffect } from "react";
import { trackPageView, initializePostHog } from "./utils/analytics";
import { AOIProvider } from "./contexts/AOIContext";
import { useDatasetSubscription } from "./hooks/useDatasetSubscription";
import { AuditNavigationProvider } from "./hooks/useAuditNavigation";

import Navigation from "./components/Navigation";
import Footer from "./components/Footer";
import { PublicOnly, RequireAuth } from "./components/AuthGate";
import { antdTheme } from "./theme/antdTheme";

import DatasetDetails from "./pages/DatasetDetails";
import RouteErrorBoundary from "./components/RouteErrorBoundary";

// Load route-specific maps, editors, and charts when that route is opened.
const HomePage = lazy(() => import("./pages/Home"));
const ProfilePage = lazy(() => import("./pages/Profile"));
const Dataset = lazy(() => import("./pages/Dataset"));
const DatasetAudit = lazy(() => import("./pages/DatasetAudit"));
const DatasetMLTiles = lazy(() => import("./pages/DatasetMLTiles"));
const DatasetReferencePatchEditor = lazy(
  () => import("./pages/DatasetReferencePatchEditor"),
);
const DatasetLabelEditor = lazy(() => import("./pages/DatasetLabelEditor"));
const DatasetCorrections = lazy(() => import("./pages/DatasetCorrections"));
const Deadtrees = lazy(() => import("./pages/Deadtrees"));
const PriwaField = lazy(() => import("./pages/PriwaField"));
const Releases = lazy(() => import("./pages/Releases"));
const ReleaseDetail = lazy(() => import("./pages/ReleaseDetail"));
const SignUp = lazy(() => import("./pages/auth/SignUp"));
const SignIn = lazy(() => import("./pages/auth/SignIn"));
const Forgotpassword = lazy(() => import("./pages/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/auth/ResetPassword"));
const About = lazy(() => import("./pages/About"));
const Impressum = lazy(() => import("./pages/Impressum"));
const Datenschutzerklaerung = lazy(
  () => import("./pages/Datenschutzerklaerung"),
);
const TermsOfService = lazy(() => import("./pages/TermsOfService"));
const FactoryLayout = lazy(() => import("./components/Factory/FactoryLayout"));
const FactoryOverview = lazy(
  () => import("./components/Factory/FactoryOverview"),
);
const FactoryDatasets = lazy(
  () => import("./components/Factory/FactoryDatasets"),
);
const FactoryDatasetDetail = lazy(
  () => import("./components/Factory/FactoryDatasetDetail"),
);
const FactoryActivity = lazy(
  () => import("./components/Factory/FactoryActivity"),
);

const { Content } = Layout;

function LayoutWrapper() {
  const location = useLocation();

  // Initialize dataset subscription for notifications across all pages
  useDatasetSubscription();

  const fullHeightPaths = [
    "/dataset",
    "/deadtrees",
    "/priwa-field",
    "/dataset-audit",
    "/dataset-label",
    "/dataset-corrections",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
  ];

  const shouldUseFullHeight = fullHeightPaths.some((path) =>
    location.pathname.startsWith(path),
  );

  return (
    <div>
      <Layout
        className={shouldUseFullHeight ? "dt-full-height-layout" : undefined}
        style={{
          margin: "0 auto",
          backgroundColor: "var(--dt-surface-base)",
        }}
      >
        <Navigation />
        <Content
          style={{
            flex: shouldUseFullHeight ? 1 : undefined,
            minHeight: shouldUseFullHeight ? 0 : undefined,
            backgroundColor: "var(--dt-surface-base)",
          }}
        >
          <RouteErrorBoundary key={location.pathname}>
            <Suspense
              fallback={
                <div className="flex min-h-60 items-center justify-center">
                  <Spin size="large" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </Content>
        {!shouldUseFullHeight && <Footer />}
      </Layout>
    </div>
  );
}

function RouteScrollRestoration() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      requestAnimationFrame(() => {
        document.getElementById(hash.slice(1))?.scrollIntoView();
      });
      return;
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname, hash]);

  return null;
}

// Create a separate component for tracking that uses hooks
function AppWithTracking() {
  const location = useLocation();

  useEffect(() => {
    window.dispatchEvent(new Event("deadtrees:route-change"));
  }, [location.pathname, location.search]);

  useEffect(() => {
    // Initialize PostHog on app load
    initializePostHog();
  }, []);

  useEffect(() => {
    // Search/filter URL edits are state changes within the same page.
    trackPageView(location.pathname);
  }, [location.pathname]);

  return (
    <>
      <RouteScrollRestoration />
      <Routes>
        <Route path="/" element={<LayoutWrapper />}>
          <Route path="/" element={<HomePage />} />
          <Route
            path="profile"
            element={
              <RequireAuth>
                <ProfilePage />
              </RequireAuth>
            }
          />
          <Route path="dataset" element={<Dataset />} />
          <Route path="dataset/:id" element={<DatasetDetails />} />
          <Route path="dataset-audit" element={<DatasetAudit />} />
          <Route path="dataset-audit/:id" element={<DatasetAudit />} />
          {/* New route for Reference Patch Editor */}
          <Route
            path="dataset-audit/:id/reference-patches"
            element={<DatasetReferencePatchEditor />}
          />
          {/* Old route kept for backward compatibility */}
          <Route
            path="dataset-audit/:id/ml-tiles"
            element={<DatasetMLTiles />}
          />
          {/* Internal read-only operations workspace; gated by can_operate */}
          <Route path="factory" element={<FactoryLayout />}>
            <Route index element={<FactoryOverview />} />
            <Route path="datasets" element={<FactoryDatasets />} />
            <Route path="datasets/:id" element={<FactoryDatasetDetail />} />
            <Route path="activity" element={<FactoryActivity />} />
          </Route>
          <Route path="dataset-label/:id" element={<DatasetLabelEditor />} />
          {/* Public labelling / corrections editor */}
          <Route
            path="dataset-corrections/:id"
            element={<DatasetCorrections />}
          />
          <Route path="deadtrees" element={<Deadtrees />} />
          <Route
            path="priwa-field"
            element={
              <RequireAuth>
                <PriwaField />
              </RequireAuth>
            }
          />
          <Route path="releases" element={<Releases />} />
          <Route path="releases/:slug" element={<ReleaseDetail />} />
          <Route path="about" element={<About />} />
          <Route path="impressum" element={<Impressum />} />
          <Route
            path="datenschutzerklaerung"
            element={<Datenschutzerklaerung />}
          />
          <Route path="terms-of-service" element={<TermsOfService />} />
          <Route
            path="sign-up"
            element={
              <PublicOnly>
                <SignUp />
              </PublicOnly>
            }
          />
          <Route
            path="sign-in"
            element={
              <PublicOnly>
                <SignIn />
              </PublicOnly>
            }
          />
          <Route path="forgot-password" element={<Forgotpassword />} />
          <Route path="reset-password" element={<ResetPassword />} />
        </Route>
      </Routes>
    </>
  );
}

// Main App component that doesn't use hooks directly
export default function App() {
  return (
    <ConfigProvider theme={antdTheme}>
      <AntdApp>
        <AOIProvider>
          <AuditNavigationProvider>
            <AppWithTracking />
          </AuditNavigationProvider>
        </AOIProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
