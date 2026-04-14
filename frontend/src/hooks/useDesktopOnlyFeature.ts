import { message } from "antd";
import { useCallback } from "react";
import { useIsMobile } from "./useIsMobile";

type DesktopOnlyFeature = "upload" | "download" | "account";

const desktopOnlyMessages: Record<DesktopOnlyFeature, string> = {
  upload: "Uploading data is currently available on desktop only.",
  download: "Downloading datasets is currently available on desktop only.",
  account: "Account management is currently available on desktop only.",
};

export function useDesktopOnlyFeature() {
  const isMobile = useIsMobile();

  const notifyDesktopOnly = useCallback((feature: DesktopOnlyFeature) => {
    message.info(desktopOnlyMessages[feature]);
  }, []);

  const runDesktopOnlyAction = useCallback(
    (feature: DesktopOnlyFeature, action: () => void) => {
      if (isMobile) {
        notifyDesktopOnly(feature);
        return false;
      }

      action();
      return true;
    },
    [isMobile, notifyDesktopOnly],
  );

  return { isMobile, notifyDesktopOnly, runDesktopOnlyAction };
}
