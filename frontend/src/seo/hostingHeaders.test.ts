import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getSitemapPaths, PRIVATE_PAGE_TITLES } from "./pageMeta";

interface HostingHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

const firebaseConfig = JSON.parse(
  readFileSync(resolve(__dirname, "../../firebase.json"), "utf8"),
) as { hosting: { headers: HostingHeaderRule[] } };

// Enough of Firebase Hosting's glob syntax for the patterns this config uses:
// `@(a|b)` alternatives and a trailing `/**`.
const globToRegExp = (glob: string): RegExp => {
  const pattern = glob
    .replace(/[.+^${}[\]\\]/g, "\\$&")
    .replace(/@\(([^)]*)\)/g, "($1)")
    .replace(/\/\*\*$/, "/.+")
    .replace(/\*\*/g, ".*");
  return new RegExp(`^${pattern}$`);
};

const noindexSources = firebaseConfig.hosting.headers
  .filter(({ headers }) =>
    headers.some(
      ({ key, value }) => key === "X-Robots-Tag" && value.includes("noindex"),
    ),
  )
  .map(({ source }) => globToRegExp(source));

const sendsNoindex = (path: string) =>
  noindexSources.some((pattern) => pattern.test(path));

describe("Hosting X-Robots-Tag header", () => {
  it.each(Object.keys(PRIVATE_PAGE_TITLES))(
    "marks %s and its sub-pages noindex before JavaScript runs",
    (root) => {
      expect(sendsNoindex(root)).toBe(true);
      expect(sendsNoindex(`${root}/15073`)).toBe(true);
    },
  );

  it("leaves every sitemap page indexable", () => {
    for (const path of getSitemapPaths()) {
      expect(sendsNoindex(path), path).toBe(false);
    }
  });

  it("leaves dataset pages indexable", () => {
    expect(sendsNoindex("/dataset/6262")).toBe(false);
  });
});
