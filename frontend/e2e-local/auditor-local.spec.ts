import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rgbGeoTiffFixture = path.resolve(
  __dirname,
  "../test/fixtures/geotiff/upload-validation/rgb-real-crop.tif",
);

const localSupabaseUrl = "http://127.0.0.1:54321";
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
  final_assessment: null,
  deadwood_quality: null,
  forest_cover_quality: null,
  has_major_issue: null,
  audit_date: null,
  has_valid_acquisition_date: null,
  has_valid_phenology: null,
  audited_by: null,
  audited_by_email: null,
  show_deadwood_predictions: true,
  show_forest_cover_predictions: true,
};

const auditedDataset = {
  ...completeDataset,
  id: 3002,
  file_name: "audit-completed-local.tif",
  is_audited: true,
  final_assessment: "fixable_issues",
  deadwood_quality: "sentinel_ok",
  forest_cover_quality: "great",
  has_valid_acquisition_date: true,
  has_valid_phenology: false,
  audited_by: auditor.id,
  audited_by_email: auditor.email,
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

let savedAuditPayloads: Array<Record<string, unknown>> = [];
let savedAoiPayloads: Array<Record<string, unknown>> = [];

const createUnsignedJwt = (payload: Record<string, unknown>) => {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      aud: "authenticated",
      role: "authenticated",
      sub: auditor.id,
      email: auditor.email,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      ...payload,
    }),
    "local-e2e",
  ].join(".");
};

const createLocalSession = () => {
  const now = new Date().toISOString();

  return {
    access_token: createUnsignedJwt({}),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "local-auditor-e2e-refresh-token",
    user: {
      id: auditor.id,
      aud: "authenticated",
      role: "authenticated",
      email: auditor.email,
      email_confirmed_at: now,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: now,
      updated_at: now,
    },
  };
};

const installAuthenticatedUser = async (
  page: Page,
  options: { canAudit: boolean },
) => {
  const session = createLocalSession();

  await page.addInitScript((localSession) => {
    window.localStorage.setItem(
      "sb-127-auth-token",
      JSON.stringify(localSession),
    );
  }, session);

  await page.route(`${localSupabaseUrl}/auth/v1/user`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: session.user,
    });
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
  options: { canAudit: boolean },
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
      created_at: "2026-01-01T00:00:00Z",
    });
    return;
  }

  if (resource === "v2_full_dataset_view") {
    const idFilter = url.searchParams.get("id");
    if (idFilter?.startsWith("eq.")) {
      const dataset = datasets.find((row) => row.id === Number(idFilter.slice(3)));
      await fulfillJson(route, wantsObject ? dataset ?? null : dataset ? [dataset] : []);
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

  if (resource === "v2_processing_overview") {
    await fulfillJson(route, [
      {
        dataset_id: incompleteDataset.id,
        file_name: incompleteDataset.file_name,
        processing_status: "FAILED",
        current_status: "cog",
        has_error: true,
        error_message: "COG conversion failed in local smoke fixture",
        hours_in_current_status: 7.25,
        status_last_updated: "2026-01-05T03:04:05Z",
        user_email: reporter.email,
        queue_priority: 4,
        queued_at: "2026-01-05T01:04:05Z",
        is_upload_done: true,
        is_odm_done: true,
        is_ortho_done: true,
        is_cog_done: false,
        is_thumbnail_done: false,
        is_metadata_done: false,
        is_deadwood_done: false,
        is_forest_cover_done: false,
        is_combined_model_done: false,
        last_20_logs: "ERROR COG conversion failed\nINFO retry pending",
      },
    ]);
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

  if (resource === "v2_statuses") {
    if (method === "PATCH") {
      await fulfillJson(route, {
        id: completeDataset.id,
        dataset_id: completeDataset.id,
        is_in_audit: false,
      });
      return;
    }

    await fulfillJson(route, wantsObject ? { is_in_audit: false } : []);
    return;
  }

  if (resource === "v2_aois" || resource === "v2_orthos") {
    if (resource === "v2_aois" && method === "POST") {
      const payload = request.postDataJSON();
      const rows = Array.isArray(payload) ? payload : [payload];
      savedAoiPayloads.push(...(rows as Array<Record<string, unknown>>));
      await fulfillJson(route, rows);
      return;
    }

    await fulfillJson(route, wantsObject ? null : []);
    return;
  }

  if (resource === "dataset_audit") {
    if (method === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: { "content-range": "0-0/1" },
      });
      return;
    }

    if (method === "POST" || method === "PATCH") {
      const payload = request.postDataJSON() ?? {};
      const rows = Array.isArray(payload) ? payload : [payload];
      savedAuditPayloads.push(...(rows as Array<Record<string, unknown>>));
      await fulfillJson(route, rows.map((row) => ({ ...row, id: 1 })));
      return;
    }

    await fulfillJson(route, []);
    return;
  }

  await fulfillJson(route, wantsObject ? null : []);
};

const fulfillRpc = async (route: Route, rpcName: string | undefined) => {
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
    savedAuditPayloads = [];
    savedAoiPayloads = [];
  });

  test("non-auditor cannot open the audit workspace", async ({ page }) => {
    await installAuthenticatedUser(page, { canAudit: false });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);

    await expect(page.getByText("Forbidden")).toBeVisible();
    await expect(
      page.getByText("Auditor access is required to view this page."),
    ).toBeVisible();
  });

  test("auditor can triage audit queues and inspect processing logs", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);

    await expect(
      page.getByRole("heading", { name: "Dataset Audits" }),
    ).toBeVisible();
    await expect(page.getByText("Local Forest")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start Audit" }),
    ).toBeVisible();

    await page.getByText("Completed").click();
    await expect(page.getByText("Fixable")).toBeVisible();
    await expect(page.getByText(auditor.email)).toBeVisible();
    await page.getByPlaceholder("Filter by ID").fill(String(auditedDataset.id));
    await expect(
      page.locator("tr").filter({ hasText: String(auditedDataset.id) }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear all filters" }).click();

    await page.getByText("Edits & Flags").click();
    await expect(page.getByText("Pending Edits").first()).toBeVisible();
    await expect(page.getByText("Flags").first()).toBeVisible();

    await page.getByText("Reference").click();
    await expect(
      page.getByRole("button", { name: "Generate Patches" }),
    ).toBeVisible();

    await page.getByText("Processing").click();
    const processingRow = page.locator("tr").filter({
      hasText: incompleteDataset.file_name,
    });
    await expect(processingRow).toBeVisible();
    await expect(processingRow.getByText("FAILED", { exact: true })).toBeVisible();
    await expect(
      processingRow.getByText("COG conversion failed in local smoke fixture"),
    ).toBeVisible();

    await page.getByRole("button", { name: "View Logs" }).click();
    await expect(
      page.getByText(`Dataset ${incompleteDataset.id} Logs`),
    ).toBeVisible();
    const logsDrawer = page.getByLabel(`Dataset ${incompleteDataset.id} Logs`);
    await expect(
      logsDrawer.getByText("COG conversion failed in local smoke fixture"),
    ).toBeVisible();
  });

  test("auditor start action checks the lock before opening detail", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);
    await page.getByRole("button", { name: "Start Audit" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/dataset-audit/${completeDataset.id}(?:\\?.*)?$`),
    );
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Audit: ${completeDataset.id}`),
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(reporter.email)).toBeVisible();
    await expect(page.getByText("1. Georeferencing Accuracy")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^save Save$/i }),
    ).toBeVisible();
  });

  test("auditor can complete the audit form with AOI and save the review", async ({
    page,
  }) => {
    await installAuthenticatedUser(page, { canAudit: true });

    await page.goto("/dataset-audit");
    await dismissCookieBanner(page);
    await page.getByRole("button", { name: "Start Audit" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/dataset-audit/${completeDataset.id}(?:\\?.*)?$`),
    );
    await expect(page.getByTestId("dataset-audit-map")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.locator('[data-testid="dataset-audit-map"] .ol-viewport'),
    ).toBeVisible({ timeout: 20_000 });

    await card(page, "1. Georeferencing Accuracy")
      .getByText(/Good/)
      .click();
    await card(page, "2. Acquisition Date")
      .getByText(/Valid/)
      .click();

    const phenologyCard = card(page, "3. Phenology / Season");
    await phenologyCard.getByText(/In Season/).click();
    await phenologyCard
      .getByPlaceholder("Seasonal observations...")
      .fill("Leaf-on season confirmed in local workflow smoke.");

    const predictionCard = card(page, "4. Prediction Quality");
    await predictionCard.getByText("🟡 OK").nth(0).click();
    await predictionCard
      .getByPlaceholder("Deadwood cover notes...")
      .fill("Deadwood cover is usable with minor noise.");
    await predictionCard.getByText("🟢 Great").nth(1).click();
    await predictionCard
      .getByPlaceholder("Forest cover notes...")
      .fill("Tree cover looks consistent.");

    const cogCard = card(page, "5. Cloud-Optimized GeoTIFF");
    await cogCard.getByText(/Good/).click();
    await cogCard
      .getByPlaceholder(/COG issue details/)
      .fill("COG renders correctly in the audit map.");

    const thumbnailCard = card(page, "6. Thumbnail");
    await thumbnailCard.getByText(/Good/).click();
    await thumbnailCard
      .getByPlaceholder(/Thumbnail issue details/)
      .fill("Thumbnail represents the dataset.");

    await drawAuditAoi(page);
    await expect(page.getByText(/AOI defined/)).toBeVisible();

    const finalAssessmentCard = card(page, "8. Final Assessment");
    await finalAssessmentCard.getByText(/Ready/).click();
    await finalAssessmentCard
      .getByPlaceholder("Additional observations...")
      .fill("Audit workflow local smoke completed.");

    await page.getByRole("button", { name: /^save Save$/i }).click();

    await expect
      .poll(() => savedAoiPayloads.length, { timeout: 10_000 })
      .toBe(1);
    await expect
      .poll(() => savedAuditPayloads.length, { timeout: 10_000 })
      .toBe(1);

    expect(savedAoiPayloads[0]).toMatchObject({
      dataset_id: completeDataset.id,
      user_id: auditor.id,
      is_whole_image: false,
    });
    expect(savedAoiPayloads[0].geometry).toMatchObject({
      type: "MultiPolygon",
    });

    expect(savedAuditPayloads[0]).toMatchObject({
      dataset_id: completeDataset.id,
      is_georeferenced: true,
      has_valid_acquisition_date: true,
      has_valid_phenology: true,
      deadwood_quality: "sentinel_ok",
      deadwood_notes: "Deadwood cover is usable with minor noise.",
      forest_cover_quality: "great",
      forest_cover_notes: "Tree cover looks consistent.",
      has_cog_issue: false,
      cog_issue_notes: "COG renders correctly in the audit map.",
      has_thumbnail_issue: false,
      thumbnail_issue_notes: "Thumbnail represents the dataset.",
      final_assessment: "no_issues",
      notes: "Audit workflow local smoke completed.",
      aoi_done: true,
      audited_by: auditor.id,
    });
  });
});

const card = (page: Page, title: string) =>
  page.locator(".ant-card").filter({ hasText: title });

const dismissCookieBanner = async (page: Page) => {
  await page
    .getByRole("button", { name: "Accept" })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
};

const drawAuditAoi = async (page: Page) => {
  await card(page, "7. Area of Interest (AOI)")
    .getByRole("button", { name: "Draw AOI Polygon" })
    .click();

  const map = page.getByTestId("dataset-audit-map");
  await expect(
    card(page, "7. Area of Interest (AOI)").getByRole("button", {
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
