import { useState, useEffect } from "react";
import { Alert, Button, Space, Typography } from "antd";
import { useLocation } from "react-router-dom";
import { initializePostHog, isConsentNeeded, saveConsent } from "../../utils/analytics";

const { Text, Link } = Typography;
const PREVIEW_WARNING_STORAGE_KEY = "deadtrees-preview-warning-shown";
const PREVIEW_WARNING_EVENT = "deadtrees:preview-warning-visibility";

export function CookieBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [isSuppressed, setIsSuppressed] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const shouldSuppressForPreview =
      location.pathname === "/deadtrees" && !sessionStorage.getItem(PREVIEW_WARNING_STORAGE_KEY);
    setIsSuppressed(shouldSuppressForPreview);
  }, [location.pathname]);

  useEffect(() => {
    const handlePreviewWarningVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      setIsSuppressed(Boolean(detail?.open));
    };

    window.addEventListener(PREVIEW_WARNING_EVENT, handlePreviewWarningVisibility as EventListener);
    return () => {
      window.removeEventListener(PREVIEW_WARNING_EVENT, handlePreviewWarningVisibility as EventListener);
    };
  }, []);

  useEffect(() => {
    // Check if consent is needed (missing or outdated)
    if (isConsentNeeded()) {
      setIsVisible(true);
      // Initialize with limited functionality until user decides
      initializePostHog("pending");
    } else {
      // Use existing consent
      const consent = localStorage.getItem("cookieConsent");
      if (consent) {
        initializePostHog(consent);
      }
    }
  }, []);

  const handleAccept = () => {
    saveConsent("accepted");
    initializePostHog("accepted");
    setIsVisible(false);
  };

  const handleReject = () => {
    saveConsent("rejected");
    initializePostHog("rejected");
    setIsVisible(false);
  };

  if (!isVisible || isSuppressed) return null;

  return (
    <Alert
      className="fixed bottom-2 left-2 right-2 z-50 rounded-2xl p-3 shadow-lg md:bottom-4 md:left-4 md:right-4 md:p-4"
      type="info"
      showIcon={false}
      banner
      message={
        <div className="flex w-full flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex-1 md:mr-4">
            <Text className="text-sm leading-6">
              We've updated our cookie policy. This website uses cookies for analytics to help us improve our services.
              Your data helps us understand how the site is used and how we can improve it.{" "}
              <Link href="/datenschutzerklaerung" target="_blank">
                Privacy Policy
              </Link>
            </Text>
          </div>
          <Space wrap>
            <Button onClick={handleReject} type="default" className="h-9 rounded-xl px-3 text-sm shadow-sm">
              Reject
            </Button>
            <Button onClick={handleAccept} type="primary" className="h-9 rounded-xl px-3 text-sm shadow-sm">
              Accept
            </Button>
          </Space>
        </div>
      }
    />
  );
}
