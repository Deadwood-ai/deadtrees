import { Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ConfigProvider, Layout } from "antd";
import { useEffect } from "react";
import { trackPageView, initializePostHog } from "./utils/analytics";
import { AOIProvider } from "./contexts/AOIContext";
import { useDatasetSubscription } from "./hooks/useDatasetSubscription";
import { AuditNavigationProvider } from "./hooks/useAuditNavigation";

import Navigation from "./components/Navigation";
import HomePage from "./pages/Home";
import ProfilePage from "./pages/Profile";
import Dataset from "./pages/Dataset";
import DatasetDetails from "./pages/DatasetDetails";
import DatasetAudit from "./pages/DatasetAudit";
import DatasetMLTiles from "./pages/DatasetMLTiles";
import DatasetReferencePatchEditor from "./pages/DatasetReferencePatchEditor";
import DatasetLabelEditor from "./pages/DatasetLabelEditor";
import DatasetCorrections from "./pages/DatasetCorrections";
import Deadtrees from "./pages/Deadtrees";
import SignUp from "./pages/auth/SignUp";
import SignIn from "./pages/auth/SignIn";
import Forgotpassword from "./pages/auth/ForgotPassword";
import ResetPassword from "./pages/auth/ResetPassword";
import About from "./pages/About";
import Impressum from "./pages/Impressum";
import Footer from "./components/Footer";
import Datenschutzerklaerung from "./pages/Datenschutzerklaerung";
import TermsOfService from "./pages/TermsOfService";
import { antdTheme } from "./theme/antdTheme";
const { Content } = Layout;

function LayoutWrapper() {
  const location = useLocation();

  // Initialize dataset subscription for notifications across all pages
  useDatasetSubscription();

  const fullHeightPaths = [
    "/dataset",
    "/deadtrees",
    "/dataset-audit",
    "/dataset-label",
    "/dataset-corrections",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
  ];

  const shouldUseFullHeight = fullHeightPaths.some((path) => location.pathname.startsWith(path));

  return (
    <div>
      <Layout
        style={{
          margin: "0 auto",
          height: shouldUseFullHeight ? "100vh" : "auto",
          backgroundColor: "var(--dt-surface-base)",
        }}
      >
        <Navigation />
        <Content
          style={{
            height: shouldUseFullHeight ? "100vh" : "auto",
            backgroundColor: "var(--dt-surface-base)",
          }}
        >
          <Outlet />
        </Content>
        {!shouldUseFullHeight && <Footer />}
      </Layout>
    </div>
  );
}

// Create a separate component for tracking that uses hooks
function AppWithTracking() {
  const location = useLocation();

  useEffect(() => {
    // Initialize PostHog on app load
    initializePostHog();

    // Track initial page view
    trackPageView(window.location.href);
  }, []);

  useEffect(() => {
    // Track page view on route change
    trackPageView(location.pathname + location.search);
  }, [location]);

  return (
    <Routes>
      <Route path="/" element={<LayoutWrapper />}>
        <Route path="/" element={<HomePage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="dataset" element={<Dataset />} />
        <Route path="dataset/:id" element={<DatasetDetails />} />
        <Route path="dataset-audit" element={<DatasetAudit />} />
        <Route path="dataset-audit/:id" element={<DatasetAudit />} />
        {/* New route for Reference Patch Editor */}
        <Route path="dataset-audit/:id/reference-patches" element={<DatasetReferencePatchEditor />} />
        {/* Old route kept for backward compatibility */}
        <Route path="dataset-audit/:id/ml-tiles" element={<DatasetMLTiles />} />
        <Route path="dataset-label/:id" element={<DatasetLabelEditor />} />
        {/* Public labelling / corrections editor */}
        <Route path="dataset-corrections/:id" element={<DatasetCorrections />} />
        <Route path="deadtrees" element={<Deadtrees />} />
        <Route path="about" element={<About />} />
        <Route path="impressum" element={<Impressum />} />
        <Route path="datenschutzerklaerung" element={<Datenschutzerklaerung />} />
        <Route path="terms-of-service" element={<TermsOfService />} />
        <Route path="sign-up" element={<SignUp />} />
        <Route path="sign-in" element={<SignIn />} />
        <Route path="forgot-password" element={<Forgotpassword />} />
        <Route path="reset-password" element={<ResetPassword />} />
      </Route>
    </Routes>
  );
}

// Main App component that doesn't use hooks directly
export default function App() {
  return (
    <ConfigProvider theme={antdTheme}>
      <AOIProvider>
        <AuditNavigationProvider>
          <AppWithTracking />
        </AuditNavigationProvider>
      </AOIProvider>
    </ConfigProvider>
  );
}
