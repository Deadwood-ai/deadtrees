import {
  dteAerialRelease,
  getPublicReleaseBySlug,
  publicReleases,
  satelliteMapRelease,
} from "../data/releases";

// The one owner of what search engines and link previews see for a URL. The
// browser applies it at runtime (usePageMeta) and the build writes it into the
// static pages and the sitemap (scripts/seoPagesPlugin.ts).

export const SITE_ORIGIN = "https://deadtrees.earth";
export const SITE_NAME = "deadtrees.earth";
export const DEFAULT_SOCIAL_IMAGE = "/assets/og-image.jpg";

export type JsonLd = Record<string, unknown>;

export interface PageMeta {
  title: string;
  description: string;
  noindex: boolean;
  lang: "en" | "de";
  jsonLd?: JsonLd;
}

const brand = (title: string) => `${title} | ${SITE_NAME}`;

const HOME_DESCRIPTION =
  "Open-access database of centimeter-scale drone and aerial imagery with AI-mapped standing deadwood and tree cover. Explore, download or contribute forest data.";

const SITE_JSON_LD: JsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      description: HOME_DESCRIPTION,
    },
    {
      "@type": "DataCatalog",
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/dataset`,
      description:
        "Open database of drone and aerial orthophotos of forests worldwide, with standing deadwood and tree cover segmentation.",
      keywords: [
        "tree mortality",
        "standing deadwood",
        "forest cover",
        "drone orthophotos",
        "remote sensing",
      ],
      sameAs: ["https://www.re3data.org/repository/r3d100014703"],
      citation: "https://doi.org/10.1016/j.rse.2025.115027",
      publisher: {
        "@type": "Organization",
        name: "geosense, University of Freiburg",
        url: "https://geosense.uni-freiburg.de/en",
      },
    },
  ],
};

const INDEXABLE_PAGES: Record<string, PageMeta> = {
  "/": {
    title: `${SITE_NAME} | Open drone data on global tree mortality`,
    description: HOME_DESCRIPTION,
    noindex: false,
    lang: "en",
    jsonLd: SITE_JSON_LD,
  },
  "/dataset": {
    title: brand("Drone orthophoto archive of forests worldwide"),
    description:
      "Browse and download open drone and aerial orthophotos of forests worldwide, with deadwood and tree cover segmentation. Filter by location, date and author.",
    noindex: false,
    lang: "en",
  },
  "/deadtrees": {
    title: brand("Sentinel-2 tree cover and deadwood map of Europe"),
    description: satelliteMapRelease.summary,
    noindex: false,
    lang: "en",
  },
  "/about": {
    title: brand("About the initiative"),
    description:
      "The team, partners, publications and funding behind deadtrees.earth, an open global database for mapping tree mortality from drone and satellite imagery.",
    noindex: false,
    lang: "en",
  },
  "/releases": {
    title: brand("Open datasets, maps and guides"),
    description:
      "Published benchmark datasets, data packages, satellite maps and contributor guides from deadtrees.earth for tree cover and tree mortality research.",
    noindex: false,
    lang: "en",
  },
  "/impressum": {
    title: brand("Impressum"),
    description: "Impressum und Anbieterkennzeichnung von deadtrees.earth.",
    noindex: false,
    lang: "de",
  },
  "/datenschutzerklaerung": {
    title: brand("Datenschutzerklärung"),
    description:
      "Datenschutzerklärung von deadtrees.earth: welche Daten wir verarbeiten und welche Rechte Sie haben.",
    noindex: false,
    lang: "de",
  },
  "/terms-of-service": {
    title: brand("Nutzungsbedingungen"),
    description: "Nutzungsbedingungen (Terms of Service) von deadtrees.earth.",
    noindex: false,
    lang: "de",
  },
};

const PRIVATE_PAGE_TITLES: Record<string, string> = {
  "/sign-in": "Sign in",
  "/sign-up": "Sign up",
  "/forgot-password": "Forgot password",
  "/reset-password": "Reset password",
  "/profile": "Your account",
  "/factory": "Data factory",
  "/dataset-audit": "Dataset audit",
  "/priwa-field": "PRIWA field map",
  "/releases/disturbance-benchmark": "Disturbance benchmark",
};

const releaseJsonLd = (
  release: (typeof publicReleases)[number],
): JsonLd | undefined => {
  const url = `${SITE_ORIGIN}/releases/${release.slug}`;
  if (release.type === "benchmark-dataset") {
    return {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: release.name,
      description: release.title,
      url,
      citation: release.paper.citation,
      isAccessibleForFree: true,
      includedInDataCatalog: { "@type": "DataCatalog", name: SITE_NAME },
      creator: { "@type": "Organization", name: SITE_NAME, url: SITE_ORIGIN },
    };
  }
  if (release.type === "guide") {
    return {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: release.name,
      description: release.summary,
      url,
      image: `${SITE_ORIGIN}${release.guide.primaryImage}`,
      publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_ORIGIN },
    };
  }
  return undefined;
};

/** Lowercase, no trailing slash: the form the canonical URL uses. */
export const normalizePath = (pathname: string): string => {
  const path = pathname.toLowerCase().replace(/\/+$/, "");
  return path === "" ? "/" : path;
};

export const getPageMeta = (pathname: string): PageMeta => {
  const path = normalizePath(pathname);

  const privateRoot = Object.keys(PRIVATE_PAGE_TITLES).find(
    (root) => path === root || path.startsWith(`${root}/`),
  );
  if (privateRoot) {
    return {
      title: brand(PRIVATE_PAGE_TITLES[privateRoot]),
      description: HOME_DESCRIPTION,
      noindex: true,
      lang: "en",
    };
  }

  if (INDEXABLE_PAGES[path]) return INDEXABLE_PAGES[path];

  const releaseSlug = path.match(/^\/releases\/([^/]+)$/)?.[1];
  const release = releaseSlug ? getPublicReleaseBySlug(releaseSlug) : undefined;
  if (release) {
    return {
      title: brand(release.name),
      description: release.summary,
      noindex: false,
      lang: "en",
      jsonLd: releaseJsonLd(release),
    };
  }

  return {
    title: SITE_NAME,
    description: HOME_DESCRIPTION,
    noindex: false,
    lang: "en",
  };
};

/** Pages with fixed metadata; the build writes one static HTML file for each. */
export const getStaticPagePaths = (): string[] => [
  ...Object.keys(INDEXABLE_PAGES),
  ...publicReleases
    // Map releases redirect to the live product and have no page of their own.
    .filter((release) => release.type !== "map")
    .map((release) => `/releases/${release.slug}`),
];

/** Every URL we want crawled. Data packages load their text from the database. */
export const getSitemapPaths = (): string[] => [
  ...getStaticPagePaths(),
  ...(dteAerialRelease.prepackagedPackageSlugs ?? []).map(
    (slug) => `/releases/${slug}`,
  ),
];
