import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";

import { getStaticPagePaths } from "../src/seo/pageMeta";
import {
  renderShell,
  renderSitemap,
  renderStaticPage,
} from "../src/seo/staticPages";

// Fills the shell and, after the build, writes sitemap.xml and one HTML file per
// public page next to the bundled index.html. `/` stays the plain shell because
// Hosting also serves that file for every URL without a static page.
export const seoPagesPlugin = (): Plugin => {
  let outDir = "dist";

  return {
    name: "deadtrees-seo-pages",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: renderShell,
    async closeBundle() {
      const shell = await readFile(join(outDir, "index.html"), "utf8");

      await writeFile(join(outDir, "sitemap.xml"), renderSitemap());
      await Promise.all(
        getStaticPagePaths()
          .filter((path) => path !== "/")
          .map(async (path) => {
            const file = join(outDir, path.slice(1), "index.html");
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, renderStaticPage(shell, path));
          }),
      );
    },
  };
};
