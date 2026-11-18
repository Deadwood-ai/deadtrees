import selection from "./approvedSiteSelection.json";
import type { IBenchmarkSiteSummary } from "./types";

const approvedIds = new Set(selection.approvedSiteIds);

/** Pinned curator selection: source exports may still contain withdrawn sites. */
export function approvedBenchmarkSites(sites: IBenchmarkSiteSummary[]) {
  return sites.filter((site) => approvedIds.has(site.id));
}
