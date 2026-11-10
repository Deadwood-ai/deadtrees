import {
  DEFAULT_SOCIAL_IMAGE,
  getPageMeta,
  getSitemapPaths,
  normalizePath,
  SITE_NAME,
  SITE_ORIGIN,
  type PageMeta,
} from "./pageMeta";

// Text renderers for the build. Link previews and many crawlers read the raw
// HTML and never run the app, so each public page needs its metadata on disk.

// index.html marks these two spots. The markers stay in the built shell so each
// static page can replace the same blocks.
const HEAD_BLOCK = /<!-- seo-head -->.*<!-- \/seo-head -->/s;
const BODY_BLOCK = /<!-- seo-body -->.*<!-- \/seo-body -->/s;

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderHead = (meta: PageMeta, canonicalUrl: string | null) => {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const tags = [
    "<!-- seo-head -->",
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${SITE_ORIGIN}${DEFAULT_SOCIAL_IMAGE}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  if (canonicalUrl) {
    tags.push(
      `<link rel="canonical" href="${canonicalUrl}" />`,
      `<meta property="og:url" content="${canonicalUrl}" />`,
    );
  }
  if (meta.jsonLd) {
    // "<" is escaped so release text can never close the script element.
    const json = JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c");
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  tags.push("<!-- /seo-head -->");
  return tags.join("\n    ");
};

const renderBody = (path: string, meta: PageMeta) => {
  const links = getSitemapPaths()
    .filter((link) => link !== path)
    .map((link) => `<li><a href="${link}">${link}</a></li>`)
    .join("");
  const heading = escapeHtml(meta.title.split(" | ")[0]);
  return `<!-- seo-body --><noscript><h1>${heading}</h1><p>${escapeHtml(meta.description)}</p><ul>${links}</ul></noscript><!-- /seo-body -->`;
};

/**
 * Fills the shell. The shell also answers `/` and every URL without a static
 * page, so it must not claim a canonical URL, a robots rule or the home page's
 * structured data: the app sets those once it knows the route.
 */
export const renderShell = (indexHtml: string): string => {
  const meta = { ...getPageMeta("/"), jsonLd: undefined };
  return indexHtml
    .replace(HEAD_BLOCK, () => renderHead(meta, null))
    .replace(BODY_BLOCK, () => renderBody("/", meta));
};

/** The built shell rewritten for one public page. */
export const renderStaticPage = (shellHtml: string, path: string): string => {
  const meta = getPageMeta(path);
  return shellHtml
    .replace(/<html lang="[^"]*">/, `<html lang="${meta.lang}">`)
    .replace(HEAD_BLOCK, () =>
      renderHead(meta, `${SITE_ORIGIN}${normalizePath(path)}`),
    )
    .replace(BODY_BLOCK, () => renderBody(path, meta));
};

export const renderSitemap = (): string => {
  const urls = getSitemapPaths()
    .map((path) => `  <url><loc>${SITE_ORIGIN}${normalizePath(path)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
};
