import { User } from "@supabase/supabase-js";

// Access the global posthog instance
declare const posthog: any;
const POSTHOG_PROJECT_KEY = import.meta.env.VITE_POSTHOG_PROJECT_KEY as string | undefined;

// The current cookie consent version
// Increment this whenever you want users to re-consent
export const COOKIE_CONSENT_VERSION = "1.1";

// Cookie storage keys
export const COOKIE_CONSENT_KEY = "cookieConsent";
export const COOKIE_CONSENT_VERSION_KEY = "cookieConsentVersion";

// Check if PostHog is available
const isPostHogAvailable = (): boolean => {
  return typeof posthog !== "undefined";
};

// Check if cookies are accepted and version is current
export const hasAcceptedCookies = (): boolean => {
  return (
    localStorage.getItem(COOKIE_CONSENT_KEY) === "accepted" &&
    localStorage.getItem(COOKIE_CONSENT_VERSION_KEY) === COOKIE_CONSENT_VERSION
  );
};

// Check if consent is needed (missing or outdated)
export const isConsentNeeded = (): boolean => {
  const storedVersion = localStorage.getItem(COOKIE_CONSENT_VERSION_KEY);
  return !localStorage.getItem(COOKIE_CONSENT_KEY) || storedVersion !== COOKIE_CONSENT_VERSION;
};

// Check if analytics capture is allowed - either user explicitly accepted or we're in essential mode
export const canCaptureEvents = (): boolean => {
  if (!isPostHogAvailable()) return false;

  // If user has explicitly opted in
  if (posthog.has_opted_in_capturing) return true;

  // If user has explicitly opted out
  if (posthog.has_opted_out_capturing) return false;

  // Default to false if we're not sure
  return false;
};

// Reset user consent (force them to choose again)
export const resetConsent = (): void => {
  localStorage.removeItem(COOKIE_CONSENT_KEY);
  localStorage.removeItem(COOKIE_CONSENT_VERSION_KEY);

  if (isPostHogAvailable()) {
    posthog.opt_out_capturing();
  }
};

// Save user consent with current version
export const saveConsent = (consent: "accepted" | "rejected"): void => {
  localStorage.setItem(COOKIE_CONSENT_KEY, consent);
  localStorage.setItem(COOKIE_CONSENT_VERSION_KEY, COOKIE_CONSENT_VERSION);
};

// Initialize PostHog with appropriate settings
export const initializePostHog = (consent: string | null = null): void => {
  if (!isPostHogAvailable()) return;
  if (!POSTHOG_PROJECT_KEY) return;

  // If already initialized with correct settings, don't reinitialize
  if (
    (consent === "accepted" && posthog.has_opted_in_capturing) ||
    (consent === "rejected" && posthog.has_opted_out_capturing)
  ) {
    return;
  }

  // Get consent from localStorage if not provided
  if (consent === null) {
    consent = localStorage.getItem(COOKIE_CONSENT_KEY);

    // If consent exists but version is outdated, consider it as pending
    const storedVersion = localStorage.getItem(COOKIE_CONSENT_VERSION_KEY);
    if (consent && storedVersion !== COOKIE_CONSENT_VERSION) {
      consent = "pending";
    }
  }

  // Initialize PostHog
  if (!posthog.has_opted_in_capturing && !posthog.has_opted_out_capturing) {
    posthog.init(POSTHOG_PROJECT_KEY, {
      api_host: "https://eu.i.posthog.com",
      // Use cookie persistence only if user explicitly accepted
      persistence: consent === "accepted" ? "cookie" : "memory",
      // Disable autocapture unless user explicitly accepted
      autocapture: consent === "accepted",
      // Always capture errors and performance - these are essential
      capture_pageview: true,
      capture_pageleave: consent === "accepted",
    });
  }

  // Update opt-in status based on consent
  if (consent === "accepted" && !posthog.has_opted_in_capturing) {
    posthog.opt_in_capturing();
  } else if (consent === "rejected" && !posthog.has_opted_out_capturing) {
    posthog.opt_out_capturing();
  }
};

// Track page views - always track but anonymously if no consent
export const trackPageView = (url: string): void => {
  if (!isPostHogAvailable()) return;

  if (canCaptureEvents()) {
    posthog.capture("$pageview", { url });
  } else {
    // Track anonymously with minimal data for essential analytics
    posthog.capture("$pageview", {
      url_path: new URL(url, window.location.origin).pathname,
      // Don't include identifiable data
    });
  }
};

// Identify user - only if they have consented OR they're logged in (functional necessity)
export const identifyUser = (user: User | null): void => {
  if (!isPostHogAvailable() || !user) return;

  // For logged-in users, we need some identification for functional purposes
  // But respect their cookie preferences for how much we track
  if (hasAcceptedCookies()) {
    // Full identification with all properties
    posthog.identify(user.id, {
      email: user.email,
      name: user.user_metadata?.full_name,
      login_method: user.app_metadata?.provider,
      last_login: new Date().toISOString(),
    });
  } else {
    // Minimal identification - just a stable ID for continuity
    // This is necessary for functional purposes, but we limit what we store
    posthog.identify(user.id, {
      logged_in: true,
    });
  }
};

// Track events with appropriate level of detail
export const trackEvent = (
  eventName: string,
  properties: Record<string, any> = {},
  isEssential: boolean = false,
): void => {
  if (!isPostHogAvailable()) return;

  // Only track non-essential events if user has consented
  if (!isEssential && !canCaptureEvents()) return;

  // For essential events, track with minimal data
  if (!hasAcceptedCookies()) {
    // Filter out potentially identifying properties
    const safeProperties = {
      event_type: properties.event_type,
      status: properties.status,
      page: properties.page,
    };
    posthog.capture(eventName, safeProperties);
  } else {
    // Track with full properties if user consented
    posthog.capture(eventName, properties);
  }
};

// Track email link clicks
export const trackEmailLinkClick = (campaign: string, linkType: string): void => {
  // Consider this essential since it's part of your core analytics need
  const isEssential = true;

  trackEvent(
    "email_link_clicked",
    {
      campaign,
      linkType,
      // Only include these if user has consented
      ...(hasAcceptedCookies() && {
        referrer: document.referrer,
        utm_source: new URLSearchParams(window.location.search).get("utm_source"),
        utm_medium: new URLSearchParams(window.location.search).get("utm_medium"),
        utm_campaign: new URLSearchParams(window.location.search).get("utm_campaign"),
      }),
    },
    isEssential,
  );
};
