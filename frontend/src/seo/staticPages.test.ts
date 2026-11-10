import { describe, expect, it } from "vitest";

import { renderShell, renderSitemap, renderStaticPage } from "./staticPages";

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <!-- seo-head --><title>placeholder</title><!-- /seo-head -->
  </head>
  <body>
    <!-- seo-body --><!-- /seo-body -->
    <div id="root"></div>
  </body>
</html>`;

describe("renderShell", () => {
  const shell = renderShell(INDEX_HTML);

  it("gives every URL social tags without claiming a canonical URL", () => {
    expect(shell).toContain('property="og:title"');
    expect(shell).toContain('name="twitter:card"');
    expect(shell).not.toContain('rel="canonical"');
    expect(shell).not.toContain('property="og:url"');
    expect(shell).not.toContain('name="robots"');
    expect(shell).not.toContain("application/ld+json");
  });
});

describe("renderStaticPage", () => {
  const shell = renderShell(INDEX_HTML);

  it("replaces the shell metadata with the page's own", () => {
    const html = renderStaticPage(shell, "/about");
    expect(html).toContain("<title>About the initiative | deadtrees.earth</title>");
    expect(html).toContain('<link rel="canonical" href="https://deadtrees.earth/about" />');
    expect(html).toContain('<meta property="og:url" content="https://deadtrees.earth/about" />');
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).not.toContain("WebSite");
  });

  it("marks the German legal pages as German", () => {
    expect(renderStaticPage(shell, "/impressum")).toContain('<html lang="de">');
  });

  it("gives crawlers without JavaScript the page text and links", () => {
    const html = renderStaticPage(shell, "/about");
    expect(html).toContain("<noscript><h1>About the initiative</h1>");
    expect(html).toContain('<a href="/dataset">');
    expect(html).toContain('<div id="root"></div>');
  });

  it("describes a dataset release with parseable structured data", () => {
    const html = renderStaticPage(shell, "/releases/dte-aerial-bench");
    const json = html.match(
      /<script type="application\/ld\+json">(.*?)<\/script>/s,
    )?.[1];
    expect(JSON.parse(json ?? "{}")["@type"]).toBe("Dataset");
  });
});

describe("renderSitemap", () => {
  const sitemap = renderSitemap();

  it("lists public pages and data packages", () => {
    expect(sitemap).toContain("<loc>https://deadtrees.earth/</loc>");
    expect(sitemap).toContain("<loc>https://deadtrees.earth/releases/dte-aerial-bench</loc>");
    expect(sitemap).toContain("<loc>https://deadtrees.earth/releases/tree-cover-aerial-global</loc>");
  });

  it("leaves out sign-in, internal and redirecting pages", () => {
    expect(sitemap).not.toContain("/sign-in");
    expect(sitemap).not.toContain("/factory");
    expect(sitemap).not.toContain("disturbance-benchmark");
    expect(sitemap).not.toContain("sentinel-2-satellite-map");
  });
});
