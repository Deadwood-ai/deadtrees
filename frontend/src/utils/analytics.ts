import { User } from "@supabase/supabase-js";
import posthog from "posthog-js";

const POSTHOG_PROJECT_KEY = import.meta.env.VITE_POSTHOG_PROJECT_KEY as string | undefined;
let initializedPostHogMode: "limited" | "accepted" | null = null;

export const COOKIE_CONSENT_VERSION = "1.1";
export const COOKIE_CONSENT_KEY = "cookieConsent";
export const COOKIE_CONSENT_VERSION_KEY = "cookieConsentVersion";

export type UserSegment = "visitor" | "contributor" | "core_team";

export type SourceSurface =
  | "home"
  | "auth"
  | "dataset_archive"
  | "dataset_detail"
  | "profile"
  | "audit"
  | "editor"
  | "newsletter"
  | "deadtrees_map"
  | "about"
  | "faq";

type AnalyticsBaseProperties = {
  page?: string;
  source_surface?: SourceSurface;
  is_mobile?: boolean;
  is_logged_in?: boolean;
  user_segment?: UserSegment;
  dataset_id?: number;
  status?: string;
};

export interface AnalyticsEventPropertiesMap {
  landing_cta_clicked: AnalyticsBaseProperties & {
    cta_name: string;
    action_target?: string;
    blocked_reason?: "mobile";
  };
  faq_opened: AnalyticsBaseProperties & {
    faq_item_key: string;
  };
  newsletter_signup_submitted: AnalyticsBaseProperties & {
    status: "success" | "duplicate" | "error" | "invalid_email";
  };
  dataset_archive_viewed: AnalyticsBaseProperties;
  dataset_search_used: AnalyticsBaseProperties & {
    search_length: number;
  };
  dataset_filter_applied: AnalyticsBaseProperties & {
    filter_type: string;
    filter_value?: string;
  };
  dataset_map_interacted: AnalyticsBaseProperties & {
    interaction_type: "move";
  };
  dataset_opened: AnalyticsBaseProperties & {
    dataset_id: number;
  };
  sign_up_started: AnalyticsBaseProperties & {
    auth_path: string;
  };
  sign_up_completed: AnalyticsBaseProperties & {
    auth_path: string;
  };
  sign_in_completed: AnalyticsBaseProperties & {
    auth_path: string;
  };
  upload_started: AnalyticsBaseProperties & {
    upload_type: string;
    has_labels_file: boolean;
  };
  upload_completed: AnalyticsBaseProperties & {
    dataset_id: number;
    upload_type: string;
    has_labels_file: boolean;
  };
  upload_failed: AnalyticsBaseProperties & {
    upload_type?: string;
    failure_reason: string;
  };
  processing_result_viewed: AnalyticsBaseProperties & {
    dataset_id: number;
    processing_type: "deadwood" | "forest_cover" | "deadwood_and_forest_cover";
  };
  dataset_download_started: AnalyticsBaseProperties & {
    dataset_id: number;
    download_type: "dataset" | "labels" | "orthophoto";
  };
  dataset_download_completed: AnalyticsBaseProperties & {
    dataset_id: number;
    download_type: "dataset" | "labels" | "orthophoto";
  };
  dataset_download_failed: AnalyticsBaseProperties & {
    dataset_id: number;
    download_type: "dataset" | "labels" | "orthophoto";
    failure_reason: string;
  };
  edit_started: AnalyticsBaseProperties & {
    dataset_id: number;
    layer_type: "deadwood" | "forest_cover";
  };
  edit_saved: AnalyticsBaseProperties & {
    dataset_id: number;
    layer_type: "deadwood" | "forest_cover";
  };
  edit_cancelled: AnalyticsBaseProperties & {
    dataset_id: number;
    layer_type: "deadwood" | "forest_cover";
  };
  flag_submitted: AnalyticsBaseProperties & {
    dataset_id: number;
    flag_type: "orthomosaic" | "prediction" | "mixed";
  };
  publish_started: AnalyticsBaseProperties & {
    dataset_count: number;
  };
  publish_submitted: AnalyticsBaseProperties & {
    dataset_count: number;
    publish_target: "freidata";
  };
  publish_completed: AnalyticsBaseProperties & {
    dataset_count: number;
    publish_target: "freidata";
  };
  publish_failed: AnalyticsBaseProperties & {
    dataset_count: number;
    publish_target: "freidata";
    failure_reason: string;
  };
  audit_queue_viewed: AnalyticsBaseProperties & {
    audit_tab?: string;
  };
  audit_started: AnalyticsBaseProperties & {
    dataset_id: number;
  };
  audit_completed: AnalyticsBaseProperties & {
    dataset_id: number;
    final_assessment: string;
  };
  correction_review_started: AnalyticsBaseProperties & {
    dataset_id?: number;
    review_scope: "queue" | "dataset";
  };
  correction_approved: AnalyticsBaseProperties & {
    dataset_id: number;
  };
  correction_reverted: AnalyticsBaseProperties & {
    dataset_id: number;
  };
  reference_patch_editor_opened: AnalyticsBaseProperties & {
    dataset_id: number;
  };
}

export type AnalyticsEventName = keyof AnalyticsEventPropertiesMap;

type EssentialAnalyticsProperty =
  | "page"
  | "source_surface"
  | "is_mobile"
  | "is_logged_in"
  | "user_segment"
  | "dataset_id"
  | "status"
  | "cta_name"
  | "action_target"
  | "blocked_reason"
  | "faq_item_key"
  | "auth_path"
  | "upload_type"
  | "has_labels_file"
  | "processing_type"
  | "download_type"
  | "failure_reason"
  | "layer_type"
  | "flag_type"
  | "dataset_count"
  | "publish_target"
  | "audit_tab"
  | "final_assessment"
  | "review_scope"
  | "filter_type"
  | "filter_value"
  | "interaction_type"
  | "search_length";

const ESSENTIAL_PROPERTY_KEYS: EssentialAnalyticsProperty[] = [
  "page",
  "source_surface",
  "is_mobile",
  "is_logged_in",
  "user_segment",
  "dataset_id",
  "status",
  "cta_name",
  "action_target",
  "blocked_reason",
  "faq_item_key",
  "auth_path",
  "upload_type",
  "has_labels_file",
  "processing_type",
  "download_type",
  "failure_reason",
  "layer_type",
  "flag_type",
  "dataset_count",
  "publish_target",
  "audit_tab",
  "final_assessment",
  "review_scope",
  "filter_type",
  "filter_value",
  "interaction_type",
  "search_length",
];

const ESSENTIAL_EVENTS = new Set<AnalyticsEventName>([
  "sign_up_completed",
  "sign_in_completed",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "processing_result_viewed",
  "dataset_download_started",
  "dataset_download_completed",
  "dataset_download_failed",
  "edit_started",
  "edit_saved",
  "edit_cancelled",
  "flag_submitted",
  "publish_started",
  "publish_submitted",
  "publish_completed",
  "publish_failed",
  "audit_queue_viewed",
  "audit_started",
  "audit_completed",
  "correction_review_started",
  "correction_approved",
  "correction_reverted",
  "reference_patch_editor_opened",
]);

const isPostHogAvailable = (): boolean => typeof posthog !== "undefined";

const getStorage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const getCurrentPath = (): string => {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
};

const getCurrentPage = (): string => {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
};

export const deriveUserSegment = (isLoggedIn: boolean, isCoreTeam: boolean): UserSegment => {
  if (!isLoggedIn) return "visitor";
  return isCoreTeam ? "core_team" : "contributor";
};

export const hasAcceptedCookies = (): boolean => {
  const storage = getStorage();
  if (!storage) return false;

  return (
    storage.getItem(COOKIE_CONSENT_KEY) === "accepted" &&
    storage.getItem(COOKIE_CONSENT_VERSION_KEY) === COOKIE_CONSENT_VERSION
  );
};

export const isConsentNeeded = (): boolean => {
  const storage = getStorage();
  if (!storage) return true;

  const storedVersion = storage.getItem(COOKIE_CONSENT_VERSION_KEY);
  return !storage.getItem(COOKIE_CONSENT_KEY) || storedVersion !== COOKIE_CONSENT_VERSION;
};

export const canCaptureEvents = (): boolean => {
  if (!isPostHogAvailable()) return false;
  if (posthog.has_opted_in_capturing()) return true;
  if (posthog.has_opted_out_capturing()) return false;
  return false;
};

export const resetConsent = (): void => {
  const storage = getStorage();
  storage?.removeItem(COOKIE_CONSENT_KEY);
  storage?.removeItem(COOKIE_CONSENT_VERSION_KEY);

  if (isPostHogAvailable()) {
    posthog.opt_out_capturing();
  }
};

export const saveConsent = (consent: "accepted" | "rejected"): void => {
  const storage = getStorage();
  storage?.setItem(COOKIE_CONSENT_KEY, consent);
  storage?.setItem(COOKIE_CONSENT_VERSION_KEY, COOKIE_CONSENT_VERSION);
};

export const initializePostHog = (consent: string | null = null): void => {
  if (!isPostHogAvailable() || !POSTHOG_PROJECT_KEY) return;

  if (consent === null) {
    const storage = getStorage();
    consent = storage?.getItem(COOKIE_CONSENT_KEY) ?? null;
    const storedVersion = storage?.getItem(COOKIE_CONSENT_VERSION_KEY);
    if (consent && storedVersion !== COOKIE_CONSENT_VERSION) {
      consent = "pending";
    }
  }

  const mode = consent === "accepted" ? "accepted" : "limited";

  // Persisted opt-in/out flags survive reloads, so they are not a safe proxy for whether
  // the current page has actually initialized PostHog after a deploy. We also need to
  // reconfigure PostHog when consent changes from limited mode to full cookie-backed mode.
  if (initializedPostHogMode !== mode) {
    posthog.init(POSTHOG_PROJECT_KEY, {
      api_host: "https://eu.i.posthog.com",
      persistence: mode === "accepted" ? "cookie" : "memory",
      autocapture: mode === "accepted",
      capture_pageview: true,
      capture_pageleave: mode === "accepted",
    });
    initializedPostHogMode = mode;
  }

  if (consent === "accepted" && !posthog.has_opted_in_capturing()) {
    posthog.opt_in_capturing();
  } else if (consent === "rejected" && !posthog.has_opted_out_capturing()) {
    posthog.opt_out_capturing();
  }
};

export const trackPageView = (url: string): void => {
  if (!isPostHogAvailable()) return;

  if (canCaptureEvents()) {
    posthog.capture("$pageview", { url });
    return;
  }

  posthog.capture("$pageview", {
    url_path: new URL(url, typeof window !== "undefined" ? window.location.origin : "https://deadtrees.earth").pathname,
  });
};

export const identifyUser = (user: User | null, options?: { isCoreTeam?: boolean }): void => {
  if (!isPostHogAvailable() || !user) return;

  const userSegment = deriveUserSegment(true, options?.isCoreTeam === true);

  if (hasAcceptedCookies()) {
    posthog.identify(user.id, {
      email: user.email,
      name: user.user_metadata?.full_name,
      login_method: user.app_metadata?.provider,
      last_login: new Date().toISOString(),
      user_segment: userSegment,
      is_core_team: options?.isCoreTeam === true,
    });
    return;
  }

  posthog.identify(user.id, {
    logged_in: true,
    user_segment: userSegment,
    is_core_team: options?.isCoreTeam === true,
  });
};

export const sanitizeEventProperties = (
  properties: Record<string, unknown>,
): Record<string, unknown> => {
  return ESSENTIAL_PROPERTY_KEYS.reduce<Record<string, unknown>>((safeProps, key) => {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== "") {
      safeProps[key] = value;
    }
    return safeProps;
  }, {});
};

type EventContext = {
  sourceSurface?: SourceSurface;
  isMobile?: boolean;
  isLoggedIn?: boolean;
  userSegment?: UserSegment;
  page?: string;
};

export const createAnalyticsPayload = <T extends AnalyticsEventName>(
  _eventName: T,
  properties: AnalyticsEventPropertiesMap[T],
  context: EventContext = {},
): AnalyticsEventPropertiesMap[T] => {
  return {
    ...properties,
    page: properties.page ?? context.page ?? getCurrentPage(),
    source_surface: properties.source_surface ?? context.sourceSurface,
    is_mobile: properties.is_mobile ?? context.isMobile,
    is_logged_in: properties.is_logged_in ?? context.isLoggedIn,
    user_segment: properties.user_segment ?? context.userSegment,
  };
};

export const trackEvent = (
  eventName: string,
  properties: Record<string, unknown> = {},
  isEssential = false,
): void => {
  if (!isPostHogAvailable()) return;
  if (!isEssential && !canCaptureEvents()) return;

  const payload = isEssential && !hasAcceptedCookies() ? sanitizeEventProperties(properties) : properties;
  posthog.capture(eventName, payload);
};

export const trackAppEvent = <T extends AnalyticsEventName>(
  eventName: T,
  properties: AnalyticsEventPropertiesMap[T],
  context: EventContext = {},
): void => {
  const payload = createAnalyticsPayload(eventName, properties, context);
  trackEvent(eventName, payload, ESSENTIAL_EVENTS.has(eventName));
};

export const trackAuthCompletion = (
  authEvent: "sign_in_completed" | "sign_up_completed",
  options: {
    isCoreTeam?: boolean;
    authPath?: string;
  } = {},
): void => {
  trackAppEvent(
    authEvent,
    {
      auth_path: options.authPath ?? getCurrentPath(),
      source_surface: "auth",
      user_segment: deriveUserSegment(true, options.isCoreTeam === true),
      is_logged_in: true,
    } as AnalyticsEventPropertiesMap[typeof authEvent],
  );
};

export const trackEmailLinkClick = (campaign: string, linkType: string): void => {
  trackEvent(
    "email_link_clicked",
    {
      campaign,
      linkType,
      page: getCurrentPage(),
      ...(hasAcceptedCookies() && typeof window !== "undefined" && {
        referrer: document.referrer,
        utm_source: new URLSearchParams(window.location.search).get("utm_source"),
        utm_medium: new URLSearchParams(window.location.search).get("utm_medium"),
        utm_campaign: new URLSearchParams(window.location.search).get("utm_campaign"),
      }),
    },
    true,
  );
};
