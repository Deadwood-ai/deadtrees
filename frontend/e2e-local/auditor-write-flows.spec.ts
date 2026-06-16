import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const rgbGeoTiffFixture = path.resolve(
  __dirname,
  "../test/fixtures/geotiff/upload-validation/rgb-real-crop.tif",
);

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const localApiUrl = process.env.VITE_LOCAL_API_URL || "http://localhost:8080/api/v1";

const uniqueRunId = randomUUID().replaceAll("-", "").slice(0, 12);
const auditorEmail = `auditor-write-${uniqueRunId}@example.com`;
const reporterEmail = `auditor-write-reporter-${uniqueRunId}@example.com`;
const auditorPassword = `Auditor-${uniqueRunId}!`;
const reporterPassword = `Reporter-${uniqueRunId}!`;
const cogPath = `auditor-write/${uniqueRunId}.tif`;
const cogFileName = `${uniqueRunId}.tif`;

let adminClient: SupabaseClient;
let anonClient: SupabaseClient;
let auditorUser: User;
let reporterUser: User;
let datasetId = 0;
let flagId = 0;
let privilegedUserId = 0;

test.describe("auditor local write flows", () => {
  test.skip(
    process.env.E2E_LOCAL_AUDITOR_WRITE !== "1",
    "Set E2E_LOCAL_AUDITOR_WRITE=1 and start local Supabase/API/nginx before running this write suite.",
  );

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    adminClient = createLocalSupabaseClient(
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    );
    anonClient = createLocalSupabaseClient(
      process.env.VITE_SUPABASE_ANON_KEY || requireEnv("SUPABASE_ANON_KEY"),
    );

    await expectLocalService(
      `${localSupabaseUrl}/auth/v1/settings`,
      "local Supabase",
    );
    await expectLocalService(`${localApiUrl}/`, "local API");

    await deleteAuthUsersByEmail(adminClient, auditorEmail);
    await deleteAuthUsersByEmail(adminClient, reporterEmail);

    auditorUser = await createConfirmedUser(auditorEmail, auditorPassword);
    reporterUser = await createConfirmedUser(reporterEmail, reporterPassword);
    privilegedUserId = await grantAuditPrivilege(auditorUser.id);
    datasetId = await createAuditableDataset();
    flagId = await createOpenFlag();
  });

  test.afterAll(async () => {
    await cleanupDataset();
    await cleanupAuditPrivilege();
    if (adminClient) {
      await deleteAuthUsersByEmail(adminClient, auditorEmail);
      await deleteAuthUsersByEmail(adminClient, reporterEmail);
    }
    fs.rmSync(path.join(repoRoot, "data", "cogs", cogPath), { force: true });
  });

  test("auditor acknowledges a user flag, draws AOI, and persists audit side effects", async ({
    page,
  }) => {
    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);

    await expect(
      page.getByRole("heading", { name: new RegExp(`Audit: ${datasetId}`) }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Securing audit lock...")).toBeHidden({
      timeout: 20_000,
    });
    await expectAuditLock(true);

    await expect(page.getByText("User-reported issues")).toBeVisible();
    await expect(page.getByText("Local auditor write issue")).toBeVisible();
    await page.getByRole("button", { name: "Acknowledge" }).click();
    await expectFlagStatus("acknowledged");

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
      .fill("Local write suite confirms phenology.");

    const predictionCard = card(page, "4. Prediction Quality");
    await predictionCard.getByText(/Great/).nth(0).click();
    await predictionCard
      .getByPlaceholder("Deadwood cover notes...")
      .fill("Deadwood prediction is fit for audit.");
    await predictionCard.getByText(/OK/).nth(1).click();
    await predictionCard
      .getByPlaceholder("Forest cover notes...")
      .fill("Tree cover is usable.");

    const cogCard = card(page, "5. Cloud-Optimized GeoTIFF");
    await cogCard.getByText(/Good/).click();
    await cogCard
      .getByPlaceholder(/COG issue details/)
      .fill("COG loads from local nginx.");

    const thumbnailCard = card(page, "6. Thumbnail");
    await thumbnailCard.getByText(/Good/).click();
    await thumbnailCard
      .getByPlaceholder(/Thumbnail issue details/)
      .fill("Thumbnail state accepted.");

    await drawAuditAoi(page);
    await expect(page.getByText(/AOI defined/)).toBeVisible();

    const finalAssessmentCard = card(page, "8. Final Assessment");
    await finalAssessmentCard.getByText(/Ready/).click();
    await finalAssessmentCard
      .getByPlaceholder("Additional observations...")
      .fill("Auditor local write integration completed.");

    await page.getByRole("button", { name: /^save Save$/i }).click();
    await expect(page).toHaveURL(/\/dataset-audit(?:\?tab=pending)?$/, {
      timeout: 20_000,
    });

    await expectAuditSideEffects();
  });
});

async function expectLocalService(url: string, name: string) {
  const response = await fetch(url).catch((error) => {
    throw new Error(`${name} is not reachable at ${url}: ${String(error)}`);
  });

  if (!response.ok) {
    throw new Error(`${name} returned ${response.status} for ${url}`);
  }
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for the local auditor write suite.`);
  }
  return value;
}

function createLocalSupabaseClient(key: string) {
  return createClient(localSupabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function createConfirmedUser(email: string, password: string) {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw error ?? new Error(`Failed to create local user ${email}`);
  }

  return data.user;
}

async function findAuthUserByEmail(client: SupabaseClient, email: string) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 100,
    });

    if (error) {
      throw error;
    }

    const user = data.users.find((candidate) => candidate.email === email);
    if (user) {
      return user;
    }

    if (data.users.length < 100) {
      return null;
    }
  }

  return null;
}

async function deleteAuthUsersByEmail(client: SupabaseClient, email: string) {
  let user = await findAuthUserByEmail(client, email);

  while (user) {
    const { error } = await client.auth.admin.deleteUser(user.id);
    if (error) {
      throw error;
    }
    user = await findAuthUserByEmail(client, email);
  }
}

async function grantAuditPrivilege(userId: string) {
  const { data, error } = await adminClient
    .from("privileged_users")
    .insert({
      user_id: userId,
      can_upload_private: false,
      can_view_all_private: false,
      can_audit: true,
    })
    .select("id")
    .single();

  expect(error).toBeNull();
  return data.id as number;
}

async function createAuditableDataset() {
  const { data: dataset, error: datasetError } = await adminClient
    .from("v2_datasets")
    .insert({
      file_name: `auditor-write-${uniqueRunId}.tif`,
      user_id: reporterUser.id,
      license: "CC BY",
      platform: "drone",
      authors: ["Local Auditor Write Reporter"],
      data_access: "public",
      aquisition_year: 2024,
      aquisition_month: 5,
      aquisition_day: 6,
      additional_information: "Local auditor write integration fixture",
    })
    .select("id")
    .single();

  expect(datasetError).toBeNull();
  const createdDatasetId = dataset.id as number;

  const { error: statusError } = await adminClient.from("v2_statuses").insert({
    dataset_id: createdDatasetId,
    current_status: "idle",
    is_upload_done: true,
    is_ortho_done: true,
    is_cog_done: true,
    is_thumbnail_done: true,
    is_deadwood_done: true,
    is_forest_cover_done: true,
    is_metadata_done: true,
    is_combined_model_done: true,
    has_error: false,
    is_in_audit: false,
  });
  expect(statusError).toBeNull();

  const localCogFile = path.join(repoRoot, "data", "cogs", cogPath);
  fs.mkdirSync(path.dirname(localCogFile), { recursive: true });
  fs.copyFileSync(rgbGeoTiffFixture, localCogFile);

  const { error: cogError } = await adminClient.from("v2_cogs").insert({
    dataset_id: createdDatasetId,
    cog_file_name: cogFileName,
    version: 1,
    cog_file_size: fs.statSync(localCogFile).size,
    cog_info: {},
    cog_processing_runtime: 0.1,
    cog_path: cogPath,
  });
  expect(cogError).toBeNull();

  return createdDatasetId;
}

async function createOpenFlag() {
  const { data, error } = await adminClient
    .from("dataset_flags")
    .insert({
      dataset_id: datasetId,
      created_by: reporterUser.id,
      is_ortho_mosaic_issue: true,
      is_prediction_issue: false,
      description: "Local auditor write issue",
      status: "open",
    })
    .select("id")
    .single();

  expect(error).toBeNull();
  return data.id as number;
}

async function installAuditorSession(page: Page) {
  const login = await anonClient.auth.signInWithPassword({
    email: auditorEmail,
    password: auditorPassword,
  });
  expect(login.error).toBeNull();
  expect(login.data.user?.id).toBe(auditorUser.id);
  expect(login.data.session).toBeTruthy();

  await page.addInitScript((session) => {
    window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
  }, login.data.session);
}

const card = (page: Page, title: string) =>
  page.locator(".ant-card").filter({ hasText: title });

async function dismissCookieBanner(page: Page) {
  await page
    .getByRole("button", { name: "Accept" })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
}

async function drawAuditAoi(page: Page) {
  await expect(page.getByTestId("dataset-audit-map")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-testid="dataset-audit-map"] .ol-viewport').first(),
  ).toBeVisible({ timeout: 20_000 });

  await card(page, "7. Area of Interest (AOI)")
    .getByRole("button", { name: "Draw AOI Polygon" })
    .click();

  const map = page.getByTestId("dataset-audit-map");
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
}

async function expectAuditLock(expected: boolean) {
  await expect
    .poll(async () => {
      const { data, error } = await adminClient
        .from("v2_statuses")
        .select("is_in_audit")
        .eq("dataset_id", datasetId)
        .single();
      expect(error).toBeNull();
      return data.is_in_audit;
    })
    .toBe(expected);
}

async function expectFlagStatus(status: string) {
  await expect
    .poll(async () => {
      const { data, error } = await adminClient
        .from("dataset_flags")
        .select("status")
        .eq("id", flagId)
        .single();
      expect(error).toBeNull();
      return data.status;
    })
    .toBe(status);
}

async function expectAuditSideEffects() {
  const { data: audit, error: auditError } = await adminClient
    .from("dataset_audit")
    .select(
      "dataset_id,is_georeferenced,has_valid_acquisition_date,has_valid_phenology,deadwood_quality,deadwood_notes,forest_cover_quality,forest_cover_notes,aoi_done,has_cog_issue,cog_issue_notes,has_thumbnail_issue,thumbnail_issue_notes,audited_by,notes,final_assessment",
    )
    .eq("dataset_id", datasetId)
    .single();
  expect(auditError).toBeNull();
  expect(audit).toMatchObject({
    dataset_id: datasetId,
    is_georeferenced: true,
    has_valid_acquisition_date: true,
    has_valid_phenology: true,
    deadwood_quality: "great",
    deadwood_notes: "Deadwood prediction is fit for audit.",
    forest_cover_quality: "sentinel_ok",
    forest_cover_notes: "Tree cover is usable.",
    aoi_done: true,
    has_cog_issue: false,
    cog_issue_notes: "COG loads from local nginx.",
    has_thumbnail_issue: false,
    thumbnail_issue_notes: "Thumbnail state accepted.",
    audited_by: auditorUser.id,
    notes: "Auditor local write integration completed.",
    final_assessment: "no_issues",
  });

  const { data: aois, error: aoiError } = await adminClient
    .from("v2_aois")
    .select("dataset_id,user_id,is_whole_image,geometry")
    .eq("dataset_id", datasetId);
  expect(aoiError).toBeNull();
  expect(aois).toHaveLength(1);
  expect(aois?.[0]).toMatchObject({
    dataset_id: datasetId,
    user_id: auditorUser.id,
    is_whole_image: false,
  });
  expect(aois?.[0].geometry).toMatchObject({ type: "MultiPolygon" });

  await expectAuditLock(false);

  const { data: flag, error: flagError } = await adminClient
    .from("dataset_flags")
    .select("status,resolved_by")
    .eq("id", flagId)
    .single();
  expect(flagError).toBeNull();
  expect(flag).toEqual({ status: "acknowledged", resolved_by: null });

  const { data: history, error: historyError } = await adminClient
    .from("dataset_flag_status_history")
    .select("old_status,new_status,changed_by")
    .eq("flag_id", flagId)
    .order("changed_at");
  expect(historyError).toBeNull();
  expect(history).toEqual([
    {
      old_status: "open",
      new_status: "acknowledged",
      changed_by: auditorUser.id,
    },
  ]);
}

async function cleanupAuditPrivilege() {
  if (!privilegedUserId) return;
  await deleteRows("privileged_users", "id", privilegedUserId);
  privilegedUserId = 0;
}

async function cleanupDataset() {
  if (!datasetId) return;

  if (flagId) {
    await deleteRows("dataset_flag_status_history", "flag_id", flagId);
  }
  await deleteRows("dataset_flags", "dataset_id", datasetId);
  await deleteRows("dataset_audit", "dataset_id", datasetId);
  await deleteRows("v2_aois", "dataset_id", datasetId);
  await deleteRows("v2_cogs", "dataset_id", datasetId);
  await deleteRows("v2_thumbnails", "dataset_id", datasetId);
  await deleteRows("v2_orthos", "dataset_id", datasetId);
  await deleteRows("v2_statuses", "dataset_id", datasetId);
  await deleteRows("v2_datasets", "id", datasetId);

  datasetId = 0;
  flagId = 0;
}

async function deleteRows(
  table: string,
  column: string,
  value: number | string,
) {
  const { error } = await adminClient.from(table).delete().eq(column, value);
  if (error) {
    throw new Error(
      `Failed to clean ${table}.${column}=${String(value)}: ${error.message}`,
    );
  }
}
