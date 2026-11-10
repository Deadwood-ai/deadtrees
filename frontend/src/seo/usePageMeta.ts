import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import {
  DEFAULT_SOCIAL_IMAGE,
  getPageMeta,
  normalizePath,
  SITE_NAME,
  SITE_ORIGIN,
  type PageMeta,
} from "./pageMeta";

const upsertHeadElement = (
  selector: string,
  create: () => HTMLElement,
): HTMLElement => {
  const existing = document.head.querySelector<HTMLElement>(selector);
  if (existing) return existing;
  const element = create();
  document.head.appendChild(element);
  return element;
};

const setMetaTag = (attribute: "name" | "property", key: string, value: string) => {
  upsertHeadElement(`meta[${attribute}="${key}"]`, () => {
    const meta = document.createElement("meta");
    meta.setAttribute(attribute, key);
    return meta;
  }).setAttribute("content", value);
};

const applyPageMeta = (meta: PageMeta, pathname: string) => {
  const url = `${SITE_ORIGIN}${normalizePath(pathname)}`;

  document.title = meta.title;
  document.documentElement.lang = meta.lang;
  setMetaTag("name", "description", meta.description);
  setMetaTag("name", "robots", meta.noindex ? "noindex" : "index, follow");
  setMetaTag("property", "og:site_name", SITE_NAME);
  setMetaTag("property", "og:type", "website");
  setMetaTag("property", "og:title", meta.title);
  setMetaTag("property", "og:description", meta.description);
  setMetaTag("property", "og:url", url);
  setMetaTag("property", "og:image", `${SITE_ORIGIN}${DEFAULT_SOCIAL_IMAGE}`);
  setMetaTag("name", "twitter:card", "summary_large_image");

  const canonical = upsertHeadElement('link[rel="canonical"]', () => {
    const link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    return link;
  });
  canonical.setAttribute("href", url);

  document.head
    .querySelector('script[type="application/ld+json"]')
    ?.remove();
  if (meta.jsonLd) {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.textContent = JSON.stringify(meta.jsonLd);
    document.head.appendChild(script);
  }
};

/** Applies the route's metadata. Mounted once, above the routes. */
export function RouteMeta() {
  const { pathname } = useLocation();

  useEffect(() => {
    applyPageMeta(getPageMeta(pathname), pathname);
  }, [pathname]);

  return null;
}

/**
 * Lets a mounted page refine the route's metadata, for text known only after
 * loading or for states that must not be indexed. Undone on unmount.
 */
export function usePageMetaOverride(override: Partial<PageMeta> | null) {
  const { pathname } = useLocation();
  const key = JSON.stringify(override);
  const latest = useRef(override);
  latest.current = override;

  useEffect(() => {
    if (!latest.current) return;
    applyPageMeta({ ...getPageMeta(pathname), ...latest.current }, pathname);
    return () => applyPageMeta(getPageMeta(pathname), pathname);
  }, [key, pathname]);
}
