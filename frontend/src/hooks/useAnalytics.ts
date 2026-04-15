import { useCallback } from "react";
import { useLocation } from "react-router-dom";

import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { useIsMobile } from "./useIsMobile";
import {
  AnalyticsEventName,
  AnalyticsEventPropertiesMap,
  SourceSurface,
  deriveUserSegment,
  trackAppEvent,
} from "../utils/analytics";

export function useAnalytics(sourceSurface: SourceSurface) {
  const location = useLocation();
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  const isMobile = useIsMobile();

  const userSegment = deriveUserSegment(!!user, canAudit);

  const track = useCallback(
    <T extends AnalyticsEventName>(eventName: T, properties: AnalyticsEventPropertiesMap[T]) => {
      trackAppEvent(eventName, properties, {
        page: location.pathname,
        sourceSurface,
        isMobile,
        isLoggedIn: !!user,
        userSegment,
      });
    },
    [isMobile, location.pathname, sourceSurface, user, userSegment],
  );

  return { track, userSegment };
}
