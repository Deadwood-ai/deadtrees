import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rgbGeoTiffFixture = path.resolve(
  __dirname,
  "../test/fixtures/geotiff/upload-validation/rgb-real-crop.tif",
);

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";
const auditor = {
  id: "00000000-0000-4000-8000-0000000000a1",
  email: "auditor-local-e2e@example.com",
};
const reporter = {
  id: "00000000-0000-4000-8000-0000000000b2",
  email: "reporter-local-e2e@example.com",
};

const completeDataset = {
  id: 3001,
  user_id: reporter.id,
  created_at: "2026-01-02T03:04:05Z",
  file_name: "audit-pending-local.tif",
  license: "CC BY",
  platform: "drone",
  project_id: null,
  authors: ["Audit Local Contributor"],
  aquisition_year: "2024",
  aquisition_month: "5",
  aquisition_day: "6",
  additional_information: "Audit local smoke dataset",
  data_access: "public",
  citation_doi: null,
  archived: false,
  ortho_file_name: "audit-pending-local.tif",
  ortho_file_size: 12345,
  bbox: null,
  sha256: "local-audit-sha",
  current_status: "idle",
  is_upload_done: true,
  is_odm_done: true,
  is_ortho_done: true,
  is_cog_done: true,
  is_thumbnail_done: true,
  is_deadwood_done: true,
  is_forest_cover_done: true,
  is_combined_model_done: true,
  is_metadata_done: true,
  is_audited: false,
  has_error: false,
  error_message: null,
  cog_file_name: "audit-pending-local_cog.tif",
  cog_path: "/cog/audit-pending-local.tif",
  cog_file_size: 23456,
  thumbnail_file_name: "audit-pending-local.png",
  thumbnail_path: "/thumbnails/audit-pending-local.png",
  admin_level_1: "Germany",
  admin_level_2: "Bavaria",
  admin_level_3: "Local Forest",
  biome_name: "Temperate Broadleaf and Mixed Forests",
  has_labels: true,
  has_deadwood_prediction: true,
  freidata_doi: null,
  has_ml_tiles: false,
  audit_decision: null,
};

const auditedDataset = {
  ...completeDataset,
  id: 3002,
  file_name: "audit-completed-local.tif",
  is_audited: true,
  audit_decision: "ok",
};

const incompleteDataset = {
  ...completeDataset,
  id: 3003,
  file_name: "audit-processing-local.tif",
  is_cog_done: false,
  is_thumbnail_done: false,
  is_deadwood_done: false,
  is_forest_cover_done: false,
  is_combined_model_done: false,
  is_metadata_done: false,
  current_status: "cog",
};

const datasets = [completeDataset, auditedDataset, incompleteDataset];

/** A row of audit.dataset_results: nothing run, nothing to review, unless overridden. */
const datasetResult = (dataset_id: number, over: Record<string, unknown> = {}) => ({
  dataset_id,
  current_status: "idle",
  is_processing_done: true,
  evaluation_decision: null,
  evaluation_source: null,
  cog_issue: false,
  thumbnail_issue: false,
  aoi_exists: false,
  aoi_created_at: null,
  aoi_source: null,
  aoi_model_version: null,
  georef_status: null,
  georef_offset_m: null,
  georef_source: null,
  date_replace: null,
  date_new: null,
  date_predicted: null,
  date_hdi80_days: null,
  date_model_version: null,
  date_estimated_at: null,
  date_source: null,
  phenology_probability: 0.8,
  deadwood_total: null,
  deadwood_major: null,
  deadwood_minor: null,
  deadwood_ok: null,
  forest_cover_total: null,
  forest_cover_major: null,
  forest_cover_minor: null,
  forest_cover_ok: null,
  review_required: [],
  last_reviewed_at: null,
  in_benchmark: false,
  checks_run: [],
  ...over,
});

// The dataset to review: the evaluation could not decide, there is no AOI, and no reference
// decides the georeferencing.
const datasetResults = [
  datasetResult(completeDataset.id, {
    georef_status: "needs_review",
    georef_offset_m: 22.6,
    georef_source: "check",
    deadwood_total: 20,
    deadwood_major: 4,
    deadwood_minor: 2,
    deadwood_ok: 14,
    review_required: ["evaluation", "aoi", "georef"],
  }),
  datasetResult(auditedDataset.id, {
    evaluation_decision: "ok",
    evaluation_source: "legacy",
    aoi_exists: true,
    georef_status: "estimated",
    georef_offset_m: 4.1,
    georef_source: "check",
  }),
  datasetResult(incompleteDataset.id, { is_processing_done: false, current_status: "cog" }),
];

const audits = [
  {
    dataset_id: auditedDataset.id,
    audit_date: "2026-01-03T03:04:05Z",
    is_georeferenced: true,
    has_valid_acquisition_date: true,
    acquisition_date_notes: "Date is plausible",
    has_valid_phenology: false,
    phenology_notes: "Outside expected season",
    deadwood_quality: "sentinel_ok",
    deadwood_notes: "Some model noise",
    forest_cover_quality: "great",
    forest_cover_notes: "Tree cover looks good",
    aoi_done: false,
    has_cog_issue: false,
    cog_issue_notes: null,
    has_thumbnail_issue: false,
    thumbnail_issue_notes: null,
    audited_by: auditor.id,
    notes: "Needs minor cleanup",
    has_major_issue: null,
    final_assessment: "fixable_issues",
    reviewed_at: null,
    reviewed_by: null,
    audited_by_email: auditor.email,
    uploaded_by_email: reporter.email,
    reviewed_by_email: null,
  },
];

const flags = [
  {
    id: 81,
    dataset_id: completeDataset.id,
    created_by: reporter.id,
    is_ortho_mosaic_issue: true,
    is_prediction_issue: false,
    description: "Mosaic seam is visible in the north-east corner.",
    status: "acknowledged",
    created_at: "2026-01-04T03:04:05Z",
    updated_at: "2026-01-04T03:04:05Z",
  },
];

// The georeferencing check measured a 22.6 m offset on two independent references.
const georefCheck = {
  dataset_id: completeDataset.id,
  model_version: "romav2.0.1",
  rules_version: "georef-rules-v1",
  decision: "poor",
  evidence_level: "strong",
  reason: "references_agree",
  p90_m: 22.6,
  evidence_groups: 2,
  support: 0.97,
  edge_support: 0.9,
  used_aoi: true,
  reference_evidence: [
    { provider: "esri", group: "esri", matches: 2400, inliers: 2300, inlier_fraction: 0.95, cells: 16, support: 0.97, edge_support: 0.9, p50_m: 21.9, p90_m: 22.7, holdout_p90_m: [22.1, 23.0], vote: "poor", qualified: true, decides: true, reason: null, sample_pairs: [[8.0, 48.0, 8.0003, 48.0], [8.001, 48.001, 8.0013, 48.001]] },
    { provider: "de-bw-dop20", group: "de-bw-dop20", matches: 1800, inliers: 1600, inlier_fraction: 0.9, cells: 15, support: 0.95, edge_support: 0.88, p50_m: 21.5, p90_m: 22.4, holdout_p90_m: [22.0, 22.9], vote: "poor", qualified: true, decides: true, reason: null, sample_pairs: [] },
    { provider: "wayback-12457", group: "esri", matches: 4, inliers: 0, inlier_fraction: 0, cells: 0, support: 0, edge_support: 0, p50_m: null, p90_m: null, holdout_p90_m: [], vote: null, qualified: false, decides: false, reason: "no_fit", sample_pairs: [] },
  ],
  reference_errors: { maptiler: "blank imagery" },
  metadata: {
    seconds: 9.4,
    references: {
      esri: { group: "esri", zoom: 18, capture_date: null, viewer: { kind: "xyz", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", max_zoom: 18, attribution: "Esri" } },
      "de-bw-dop20": { group: "de-bw-dop20", zoom: null, capture_date: null, viewer: { kind: "wms", url: "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C", layers: "IMAGES_DOP_20_RGB", version: "1.3.0", format: "image/jpeg", attribution: "LGL BW" } },
      "wayback-12457": { group: "esri", zoom: 18, capture_date: "2019-06-02", viewer: { kind: "xyz", url: "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/12457/{z}/{y}/{x}", max_zoom: 19, attribution: "Esri" } },
    },
  },
  updated_at: "2026-10-02T06:00:00Z",
};

let savedAnswerPayloads: Array<Record<string, unknown>> = [];
let legacyAuditWrites = 0;
let auditLeaseCalls: Array<{ rpc: string; body: Record<string, unknown> }> = [];
let auditWriteLeaseHeaders: Array<string | undefined> = [];
let savedAoiPayloads: Array<Record<string, unknown>> = [];

const installAuthenticatedUser = async (
  page: Page,
  options: {
    canAudit: boolean;
    canOperate?: boolean;
    auditDatasetRequestFails?: boolean;
  },
) => {
  await installLocalSession(page, {
    user: auditor,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "local-auditor-e2e-refresh-token",
  });

  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    await fulfillSupabaseRequest(route, options);
  });

  await page.route("**/cogs/v1/**", async (route) => {
    const buffer = fs.readFileSync(rgbGeoTiffFixture);
    const range = route.request().headers().range;

    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : buffer.length - 1;
        const end = Math.min(requestedEnd, buffer.length - 1);
        const chunk = buffer.subarray(start, end + 1);

        await route.fulfill({
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-length": String(chunk.length),
            "content-range": `bytes ${start}-${end}/${buffer.length}`,
            "content-type": "image/tiff",
          },
          body: chunk,
        });
        return;
      }
    }

    await route.fulfill({
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(buffer.length),
        "content-type": "image/tiff",
      },
      body: buffer,
    });
  });
};

const fulfillSupabaseRequest = async (
  route: Route,
  options: {
    canAudit: boolean;
    canOperate?: boolean;
    auditDatasetRequestFails?: boolean;
  },
) => {
  const request = route.request();
  const url = new URL(request.url());
  const segments = url.pathname.split("/").filter(Boolean);
  const resource = segments.at(-1);
  const method = request.method();
  const wantsObject =
    request.headers()["accept"]?.includes("vnd.pgrst.object") ?? false;

  if (segments.at(-2) === "rpc") {
    await fulfillRpc(route, resource);
    return;
  }

  if (resource === "privileged_users") {
    await fulfillJson(route, {
      id: 1,
      user_id: auditor.id,
      can_upload_private: false,
      can_audit: options.canAudit,
      can_view_all_private: false,
      can_operate: options.canOperate ?? false,
      created_at: "2026-01-01T00:00:00Z",
    });
    return;
  }

  if (resource === "v2_full_dataset_view") {
    const idFilter = url.searchParams.get("id");
    if (idFilter?.startsWith("eq.")) {
      const dataset = datasets.find(
        (row) => row.id === Number(idFilter.slice(3)),
      );
      await fulfillJson(
        route,
        wantsObject ? (dataset ?? null) : dataset ? [dataset] : [],
      );
      return;
    }

    const selectedColumns = url.searchParams.get("select");
    if (
      options.auditDatasetRequestFails &&
      selectedColumns?.split(",").includes("file_name")
    ) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        json: {
          code: "57014",
          message: "canceling statement due to statement timeout",
        },
      });
      return;
    }

    const pendingCorrectionFilter = url.searchParams.get(
      "pending_corrections_count",
    );
    if (pendingCorrectionFilter?.startsWith("gt.")) {
      await fulfillJson(route, [
        {
          id: completeDataset.id,
          pending_corrections_count: 2,
        },
      ]);
      return;
    }

    await fulfillJson(route, datasets);
    return;
  }

  if (resource === "dataset_flags") {
    await fulfillJson(route, flags);
    return;
  }

  if (resource === "reference_datasets") {
    await fulfillJson(route, [{ dataset_id: auditedDataset.id }]);
    return;
  }

  if (resource === "v2_logs") {
    await fulfillJson(route, [
      {
        id: 101,
        created_at: "2026-01-05T03:04:05Z",
        level: "ERROR",
        category: "processing",
        message: "COG conversion failed in local smoke fixture",
        origin: "processor",
        origin_line: 42,
      },
    ]);
    return;
  }

  if (resource === "v2_metadata") {
    await fulfillJson(route, []);
    return;
  }

  if (resource === "v2_georef_checks") {
    const forDataset = url.searchParams.get("dataset_id") === `eq.${completeDataset.id}`;
    await fulfillJson(route, wantsObject ? (forDataset ? georefCheck : null) : forDataset ? [georefCheck] : []);
    return;
  }

  if (resource === "dataset_results") {
    const idFilter = url.searchParams.get("dataset_id");
    const row = datasetResults.find((r) => idFilter === `eq.${r.dataset_id}`);
    await fulfillJson(route, idFilter ? (wantsObject ? (row ?? null) : row ? [row] : []) : datasetResults);
    return;
  }

  // the Audit Review stores answers as person rows of audit.assessments
  if (resource === "assessments" && method === "POST") {
    const rows = request.postDataJSON() as Array<Record<string, unknown>>;
    savedAnswerPayloads.push(...rows);
    await fulfillJson(
      route,
      rows.map((row, i) => ({ id: 900 + savedAnswerPayloads.length + i, crop_id: null, label_id: null, assessor: auditor.id, details: {}, ...row })),
    );
    return;
  }

  if (resource === "v2_statuses") {
    await fulfillJson(route, wantsObject ? { is_in_audit: false } : []);
    return;
  }

  if (resource === "v2_aois" || resource === "v2_orthos") {
    if (resource === "v2_aois" && method === "POST") {
      auditWriteLeaseHeaders.push(request.headers()["x-audit-lease"]);
      const payload = request.postDataJSON();
      const rows = Array.isArray(payload) ? payload : [payload];
      savedAoiPayloads.push(...(rows as Array<Record<string, unknown>>));
      await fulfillJson(route, rows);
      return;
    }

    if (resource === "v2_aois" && savedAoiPayloads.length > 0) {
      const latestAoi = savedAoiPayloads.at(-1);
      await fulfillJson(route, wantsObject ? latestAoi : [latestAoi]);
      return;
    }

    await fulfillJson(route, wantsObject ? null : []);
    return;
  }

  // the legacy audit is read-only history: nothing may write it
  if (resource === "dataset_audit" && method !== "GET" && method !== "HEAD") {
    legacyAuditWrites += 1;
  }

  await fulfillJson(route, wantsObject ? null : []);
};

const fulfillRpc = async (route: Route, rpcName: string | undefined) => {
  if (rpcName === "factory_overview") {
    await fulfillJson(route, {
      as_of: "2026-01-06T00:00:00Z",
      since: "2025-12-30T00:00:00Z",
      counts: {},
      workers: [],
      cohorts: [],
      coverage: [],
    });
    return;
  }

  if (
    rpcName === "claim_dataset_audit_lock" ||
    rpcName === "release_dataset_audit_lock"
  ) {
    auditLeaseCalls.push({
      rpc: rpcName,
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    await fulfillJson(
      route,
      rpcName === "claim_dataset_audit_lock"
        ? { acquired: true, expires_at: "2026-01-06T00:10:00Z" }
        : null,
    );
    return;
  }

  if (rpcName === "get_dataset_audits_with_emails") {
    await fulfillJson(route, audits);
    return;
  }

  if (rpcName === "get_dataset_audit_with_emails") {
    const body = route.request().postDataJSON() as
      | { p_dataset_id?: number }
      | undefined;
    await fulfillJson(
      route,
      audits.filter((audit) => audit.dataset_id === body?.p_dataset_id),
    );
    return;
  }

  if (rpcName === "get_dataset_contributors_with_emails") {
    await fulfillJson(route, [
      {
        dataset_id: completeDataset.id,
        contributor_email: reporter.email,
      },
      {
        dataset_id: auditedDataset.id,
        contributor_email: reporter.email,
      },
    ]);
    return;
  }

  if (rpcName === "get_user_emails") {
    await fulfillJson(route, [{ user_id: reporter.id, email: reporter.email }]);
    return;
  }

  if (
    rpcName === "get_correction_contributors" ||
    rpcName === "get_pending_correction_locations" ||
    rpcName === "update_flag_status"
  ) {
    await fulfillJson(route, []);
    return;
  }

  await fulfillJson(route, []);
};

const fulfillJson = async (route: Route, json: unknown) => {
  await route.fulfill({
    contentType: "application/json",
    headers: { "content-range": "0-0/1" },
    json,
  });
};

test.describe("auditor local e2e", () => {
  test.beforeEach(() => {
    savedAnswerPayloads = [];
    legacyAuditWrites = 0;
    savedAoiPayloads = [];
    auditLeaseCalls = [];
    auditWriteLeaseHeaders = [];
  });

  test("non-auditor cannot open the audit workspace", async ({ page }) => {
    await installAuthenticatedUser(page, { canAudit: false });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);

    await expect(page.getByTestId("status-page-locked")).toBeVisible();
    await expect(page.getByText("Auditor access needed")).toBeVisible();
  });

  for (const canAudit of [true, false]) {
    test(`${canAudit ? "auditor" : "non-auditor"} sees the AI search on the dataset archive`, async ({
      page,
    }) => {
      await installAuthenticatedUser(page, { canAudit });

      await page.goto("/dataset");
      await dismissCookieBanner(page);

      // Open-vocabulary AI search is public: the mode switch is offered to
      // every visitor next to the plain location/author search.
      await expect(page.getByTestId("dataset-search-input")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Search mode" }),
      ).toBeVisible();
    });
  }

  test("auditor moves through the Audit Review tabs, each the same table with a fixed chip", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);

    await expect(page.getByRole("heading", { name: "Audit Review", exact: true })).toBeVisible();
    const table = page.getByTestId("audit-review-table");
    await expect(table.getByText("Local Forest").first()).toBeVisible();
    await expect(page.getByTestId("audit-list-count")).toHaveText("3 of 3 datasets");
    const count = page.getByTestId("audit-list-count");

    await page.getByText("Pending audit reviews").click();
    // a subset tab: n of N, with its chip fixed
    await expect(count.locator(".ant-tag")).toHaveText("Review required");
    await expect(count).toContainText("1 of 3 datasets");
    await expect(table.getByText("Needs review (best reference 23 m)")).toBeVisible();
    await expect(table.locator(".ant-tag").filter({ hasText: "Georeferencing" })).toBeVisible();

    await page.getByText("All audits").click();
    await page.getByText("Filters").click();
    await page.getByPlaceholder("ID").fill(String(auditedDataset.id));
    await expect(count).toHaveText("1 of 3 datasets");
    await expect(table.locator(".ant-tag").filter({ hasText: /^OK$/ })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();

    await page.getByText("Edits & flags").click();
    await expect(count.locator(".ant-tag")).toHaveText("Edits or user reports");
    await expect(count).toContainText("1 of 3 datasets");

    // the lists apart from the audit, under Other
    const other = page.getByTestId("audit-list-group-1");
    await expect(other.getByRole("heading", { name: "Other" })).toBeVisible();
    await other.getByText("Segmentation Benchmark").click();
    await expect(page.getByRole("button", { name: "Generate patches" })).toBeVisible();

    await other.getByText("Legacy Manual Audits").click();
    await expect(page).toHaveURL(/view=legacy/);
    await expect(page.getByTestId("legacy-audit-list").getByText("Fixable issues")).toBeVisible();
    await expect(page.getByTestId("legacy-audit-list").getByText(auditor.email)).toBeVisible();

    await expect(page.getByText("⚙️ Processing")).toHaveCount(0);
  });

  test("the list uses an explicit lightweight dataset projection", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    const datasetRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith("/v2_full_dataset_view") && !url.searchParams.has("id") && !url.searchParams.has("pending_corrections_count");
    });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);
    const request = await datasetRequest;
    const selectedColumns = new URL(request.url()).searchParams
      .get("select")
      ?.split(",");

    expect(selectedColumns).toBeDefined();
    expect(selectedColumns).not.toContain("*");
    expect(selectedColumns).toEqual(expect.arrayContaining(["id", "file_name", "admin_level_1", "has_ml_tiles"]));
    await expect(page.getByText("Local Forest").first()).toBeVisible();
  });

  test("the list reports dataset load failures instead of showing zero", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, {
      canAudit: true,
      auditDatasetRequestFails: true,
    });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);

    await expect(
      page.getByText("The Audit Review list couldn’t load", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("DeadTrees didn’t respond. Check your connection and try again in a moment."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByText("All audits")).toHaveCount(0);
  });

  test("old processing deep link redirects operators to the Factory workspace", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true, canOperate: true });

    await page.goto("/dataset-audit?tab=processing");
    await dismissCookieBanner(page);

    await expect(page).toHaveURL(/\/factory$/);
    await expect(page.getByTestId("factory-page")).toBeVisible();
  });

  test("old processing deep link tells auditors without operator access where processing moved", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true, canOperate: false });

    await page.goto("/dataset-audit?tab=processing");
    await dismissCookieBanner(page);

    await expect(page.getByTestId("audit-processing-moved")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Audit Review", exact: true })).toBeVisible();
    await expect(page.getByText("Local Forest").first()).toBeVisible();
    await expect(page).toHaveURL(/tab=all/);
    await expect(page.getByRole("menuitem", { name: "Factory" })).toHaveCount(0);
  });

  test("auditor opens a dataset from the list and claims the review lease", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    // a filtered list: leaving the review returns to it
    await page.goto(`/dataset-audit?tab=pending&id=${completeDataset.id}`);
    await dismissCookieBanner(page);
    await page.getByRole("button", { name: "Open" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/dataset-audit/${completeDataset.id}(?:\\?.*)?$`),
    );
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Audit Review: ${completeDataset.id}`),
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(reporter.email, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^3\. Georeferencing/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^save Save$/i }),
    ).toBeVisible();
    expect(auditLeaseCalls[0]).toMatchObject({
      rpc: "claim_dataset_audit_lock",
      body: { p_dataset_id: completeDataset.id },
    });

    // Leaving through Cancel releases the same page lease; nothing changed, so it does not ask.
    const leaseId = auditLeaseCalls[0].body.p_lease_id;
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Leave Audit" })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/dataset-audit\\?tab=pending&id=${completeDataset.id}$`));
    await expect
      .poll(() =>
        auditLeaseCalls.some(
          (call) =>
            call.rpc === "release_dataset_audit_lock" &&
            call.body.p_lease_id === leaseId,
        ),
      )
      .toBe(true);
  });

  test("auditor sees the georeferencing output, its references and the matching viewer", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });
    // keep the reference basemap offline: an empty tile for every request
    await page.route(/arcgisonline\.com|wayback\.maptiles\.arcgis\.com|lgl-bw\.de/, (route) => route.fulfill({ status: 204 }));

    await page.goto(`/dataset-audit/${completeDataset.id}`);
    await dismissCookieBanner(page);

    const georef = await section(page, "Georeferencing");
    await expect(georef.getByText("Strong evidence: 22.6 m off on 90% of the area (Esri World Imagery (current) and DOP Baden-Württemberg (DE)).")).toBeVisible({ timeout: 20_000 });
    await expect(georef.getByText("Passed (≤ 15 m)")).toBeVisible();

    // opening the section puts the map into georeferencing mode: reference picker, match lines, opacity
    const panel = page.getByText("Map mode: Georeferencing").locator("..");
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Esri World Imagery \(current\).*22\.7 m/)).toBeVisible();
    await expect(panel.getByText("Unavailable: maptiler (blank imagery)")).toBeVisible();
    await expect(panel.getByRole("slider")).toBeVisible();
    await panel.locator(".ant-select").click();
    await expect(page.getByText(/Esri Wayback, captured 2019-06-02/).first()).toBeVisible();
    await expect(page.getByText(/no confident matches \(uniform canopy, season or blank imagery\)/).first()).toBeVisible();
  });

  test("the review line follows the answers on the page", async ({ page }) => {
    await installAuthenticatedUser(page, { canAudit: true });
    await page.route(/arcgisonline\.com|wayback\.maptiles\.arcgis\.com|lgl-bw\.de/, (route) => route.fulfill({ status: 204 }));

    await page.goto(`/dataset-audit/${completeDataset.id}`);
    await dismissCookieBanner(page);

    const line = page.getByTestId("audit-review-required");
    await expect(line).toHaveText("Review required for Dataset evaluation, Area of interest, Georeferencing", { timeout: 20_000 });
    await (await section(page, "Georeferencing")).getByText("Passed (≤ 15 m)").click();
    await expect(line).toHaveText("Review required for Dataset evaluation, Area of interest");
    await expect(page.getByRole("button", { name: /^3\. Georeferencing/ })).not.toContainText("Review required");
  });

  test("an exclusion is not saved without its reason", async ({ page }) => {
    await installAuthenticatedUser(page, { canAudit: true });
    await page.route(/arcgisonline\.com|wayback\.maptiles\.arcgis\.com|lgl-bw\.de/, (route) => route.fulfill({ status: 204 }));

    await page.goto(`/dataset-audit/${completeDataset.id}`);
    await dismissCookieBanner(page);

    const evaluation = await section(page, "Dataset evaluation");
    await evaluation.getByTestId("audit-evaluation-decision").getByText("Exclude", { exact: true }).click();
    await page.getByRole("button", { name: /^save Save$/i }).click();
    await expect(page.getByText("Pick why the dataset is excluded.")).toBeVisible();
    expect(savedAnswerPayloads).toHaveLength(0);
  });

  test("direct review links retain the list's navigation context", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    await page.goto(`/dataset-audit/${completeDataset.id}`);
    await dismissCookieBanner(page);

    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Audit Review: ${completeDataset.id}`),
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: /^right Save & Next$/i }),
    ).toBeVisible();
  });

  test("auditor answers the review, draws the AOI, and Save stores only person rows", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    await page.goto("/dataset-audit?tab=pending");
    await dismissCookieBanner(page);
    await page.getByRole("button", { name: "Open" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/dataset-audit/${completeDataset.id}(?:\\?.*)?$`),
    );
    await expect(
      page.locator('[data-testid="dataset-audit-map"] .ol-viewport'),
    ).toBeVisible({ timeout: 20_000 });

    const evaluation = await section(page, "Dataset evaluation");
    await evaluation.getByTestId("audit-evaluation-decision").getByText("OK", { exact: true }).click();
    await evaluation.getByLabel("Note on the decision").fill("Sharp orthophoto, usable.");
    await (await section(page, "Georeferencing")).getByText("Passed (≤ 15 m)").click();

    await drawAuditAoi(page);
    await expect(page.getByText(/AOI defined/)).toBeVisible();
    await page.getByRole("button", { name: /^save Save AOI$/i }).click();
    await expect.poll(() => savedAoiPayloads.length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByText("Unsaved AOI edits")).toBeHidden();
    await expect(page.getByTestId("audit-review-required")).toHaveText("No review required");

    await page.getByRole("button", { name: /^save Save$/i }).click();
    await expect.poll(() => savedAnswerPayloads.length, { timeout: 10_000 }).toBe(2);
    await expect(page).toHaveURL(/\/dataset-audit\?tab=pending/);

    expect(savedAoiPayloads[0]).toMatchObject({ dataset_id: completeDataset.id, user_id: auditor.id, is_whole_image: false });
    // the AOI save is bound to the lease this page claimed
    const claimedLease = auditLeaseCalls.find((call) => call.rpc === "claim_dataset_audit_lock")?.body.p_lease_id;
    expect(claimedLease).toBeTruthy();
    expect(auditWriteLeaseHeaders[0]).toBe(claimedLease);
    expect(savedAnswerPayloads).toEqual([
      expect.objectContaining({
        check_key: "dataset_evaluation",
        dataset_id: completeDataset.id,
        layer: "image",
        verdict: "ok",
        reason_text: "Sharp orthophoto, usable.",
        output: { cog_issue: false, thumbnail_issue: false },
        assessor_kind: "person",
        assessor_user_id: auditor.id,
      }),
      expect.objectContaining({
        check_key: "georef",
        dataset_id: completeDataset.id,
        layer: "georef",
        verdict: null,
        output: { status: "passed" },
        assessor_kind: "person",
      }),
    ]);
    expect(legacyAuditWrites).toBe(0);
  });
});

/** Opens an audit section (one is open at a time) and returns it. */
const section = async (page: Page, title: string) => {
  const header = page.getByRole("button", { name: new RegExp(`^\\d\\. ${title}`) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  return page.locator("section").filter({ has: header });
};

const dismissCookieBanner = async (page: Page) => {
  await page
    .getByRole("button", { name: "Accept" })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
};

const drawAuditAoi = async (page: Page) => {
  await (await section(page, "Area of interest"))
    .getByRole("button", { name: "Draw AOI Polygon" })
    .click();

  const map = page.getByTestId("dataset-audit-map");
  await expect(
    (await section(page, "Area of interest")).getByRole("button", {
      name: "Cancel Drawing",
    }),
  ).toBeVisible();

  const box = await map.boundingBox();
  if (!box) {
    throw new Error("Audit map is not visible for AOI drawing.");
  }

  const points = [
    { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 },
    { x: box.x + box.width * 0.56, y: box.y + box.height * 0.45 },
    { x: box.x + box.width * 0.56, y: box.y + box.height * 0.56 },
    { x: box.x + box.width * 0.45, y: box.y + box.height * 0.56 },
  ];

  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  await page.mouse.click(points[2].x, points[2].y);
  await page.mouse.dblclick(points[3].x, points[3].y);
};
