import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const localDataRoot = process.env.LOCAL_DATA_ROOT || path.join(repoRoot, "data");
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
let machinePredictionAoiId = 0;
let manualCorrectionAoiId = 0;

const machinePredictionGeometry = {
  type: "MultiPolygon",
  coordinates: [[[
    [13.405, 52.52],
    [13.405, 52.521],
    [13.406, 52.521],
    [13.406, 52.52],
    [13.405, 52.52],
  ]]],
};

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
    machinePredictionAoiId = await createMachinePredictionAoi();
    flagId = await createOpenFlag();
  });

  test.afterAll(async () => {
    await cleanupDataset();
    await cleanupAuditPrivilege();
    if (adminClient) {
      await deleteAuthUsersByEmail(adminClient, auditorEmail);
      await deleteAuthUsersByEmail(adminClient, reporterEmail);
    }
    fs.rmSync(path.join(localDataRoot, "cogs", cogPath), { force: true });
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
    await expectAuditLeaseHolder(auditorUser.id);

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
    await page.getByRole("button", { name: /^save Save AOI$/i }).click();
    await expect(page.getByText("Unsaved AOI edits")).toBeHidden({
      timeout: 10_000,
    });
    manualCorrectionAoiId = await expectManualCorrectionSaved(undefined, 2);
    await addManualCorrectionMetadata();

    await drawAuditAoi(page);
    const aoiCard = card(page, "7. Area of Interest (AOI)");
    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();

    await page.getByRole("button", { name: "Edit deadwood cover" }).click();
    await expect(page.getByText("Editing deadwood cover")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await aoiCard.getByRole("button", { name: "Edit" }).click();
    await expect(aoiCard.getByRole("button", { name: "Cut" })).toBeVisible();
    await aoiCard.getByRole("button", { name: "Cancel" }).click();

    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await aoiCard.getByRole("button", { name: /Undo AOI Change/i }).click();
    await expect(aoiCard.getByText(/AOI defined \(2 polygons\)/)).toBeVisible();

    await drawAuditAoi(page);
    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await aoiCard.getByRole("button", { name: "Edit" }).click();
    await expect(aoiCard.getByRole("button", { name: "Cut" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Merge" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Clip" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Undo" })).toBeVisible();
    await aoiCard.getByRole("button", { name: "Cancel" }).click();
    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await expect(page.getByText("Unsaved AOI edits")).toBeVisible();

    await page.getByRole("button", { name: /^save Save AOI$/i }).click();
    await expect(page.getByText("Unsaved AOI edits")).toBeHidden({
      timeout: 10_000,
    });
    await expectManualCorrectionSaved(manualCorrectionAoiId, 3, {
      image_quality: 2,
      notes: "Auditor metadata to preserve",
    });

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

  test("marking a saved audit reviewed releases the audit lease", async ({ page }) => {
    await ensureSavedAudit();
    await installAuditorSession(page);
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);

    await page.getByRole("button", { name: /Mark Reviewed/ }).click();
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 20_000 });

    await expectAuditLeaseHolder(null);
    expect(await readSavedAudit()).toMatchObject({
      notes: "Auditor local write integration completed.",
      audited_by: auditorUser.id,
      reviewed_by: auditorUser.id,
    });
    expect((await readSavedAudit()).reviewed_at).not.toBeNull();
  });

  test("a live lease is respected, an abandoned one is reclaimed, and page exit releases it", async ({
    page,
  }) => {
    await ensureSavedAudit();
    const savedAudit = await readSavedAudit();
    await installAuditorSession(page);

    // Another auditor is actively auditing: this auditor is sent back to the queue.
    await setAuditLease(reporterUser.id, 600);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(
      page.getByText(`This dataset is being audited by ${reporterEmail}`).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 10_000 });
    await expectAuditLeaseHolder(reporterUser.id);

    // The other auditor's page went away without releasing: the lease is reclaimable.
    await setAuditLease(reporterUser.id, -1);
    await seedDeadwoodPrediction();
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);
    await expect(page.getByRole("button", { name: "Edit deadwood cover" })).toBeVisible({ timeout: 20_000 });

    // This page was inactive past expiry and someone else claimed the dataset.
    await setAuditLease(reporterUser.id, 600);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByText("Saving is turned off on this page")).toBeVisible();
    await expect(page.getByRole("button", { name: /^save Save$/i })).toHaveCount(0);
    // Prediction edits are not offered from a page that lost the lease.
    await expect(page.getByRole("button", { name: "Edit deadwood cover" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
    await page.getByRole("button", { name: "Back to queue" }).click();
    await page.getByRole("button", { name: "Leave Audit" }).click();
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 10_000 });
    // Leaving must not clear the new holder's lease.
    await expectAuditLeaseHolder(reporterUser.id);

    // Closing or navigating the tab away releases the lease immediately.
    await deleteRows("dataset_audit_locks", "dataset_id", datasetId);
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto("about:blank");
    await expectAuditLeaseHolder(null);

    expect(await readSavedAudit()).toEqual(savedAudit);
  });

  test("a second tab of the same auditor cannot displace the lease page until they continue there", async ({
    context,
    page,
  }) => {
    await ensureSavedAudit();
    const { error: resetError } = await adminClient
      .from("dataset_audit")
      .update({ reviewed_at: null, reviewed_by: null })
      .eq("dataset_id", datasetId);
    expect(resetError).toBeNull();
    const { error: flagResetError } = await adminClient
      .from("dataset_flags")
      .update({ status: "open" })
      .eq("id", flagId);
    expect(flagResetError).toBeNull();
    await installAuditorSession(page);
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);
    const firstLease = (await readAuditLease())?.lease_id;
    // Unsaved AOI work on the first tab.
    await drawAuditAoi(page);
    await expect(page.getByText("Unsaved AOI edits")).toBeVisible();

    const secondTab = await context.newPage();
    await secondTab.goto(`/dataset-audit/${datasetId}`);
    await expect(
      secondTab.getByText("You have this dataset open in another tab or window."),
    ).toBeVisible({ timeout: 20_000 });
    expect((await readAuditLease())?.lease_id).toBe(firstLease);

    await secondTab.getByRole("button", { name: "Continue here" }).click();
    await expect(
      secondTab.getByRole("heading", { name: new RegExp(`Audit: ${datasetId}`) }),
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await readAuditLease())?.lease_id).not.toBe(firstLease);

    // Before its next renewal the first tab still believes it holds the lease. Its flag
    // review is rejected by the server, and the rejection makes it notice the takeover.
    const staleFlagReview = page.waitForResponse((response) =>
      response.url().includes("/rpc/update_flag_status"),
    );
    await page.getByRole("button", { name: "Acknowledge" }).click();
    const rejected = await staleFlagReview;
    expect(rejected.status()).toBeGreaterThanOrEqual(400);
    expect(rejected.request().headers()["x-audit-lease"]).toBe(firstLease);
    await expectFlagStatus("open");
    await expect(page.getByText("You continued this audit in another tab or window.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Mark Reviewed/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save AOI/ })).toBeDisabled();

    await secondTab.getByRole("button", { name: /Mark Reviewed/ }).click();
    await expect(secondTab).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 20_000 });
    expect(await readSavedAudit()).toMatchObject({ reviewed_by: auditorUser.id });
    await secondTab.close();
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
  });
  expect(statusError).toBeNull();

  const localCogFile = path.join(localDataRoot, "cogs", cogPath);
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

async function createMachinePredictionAoi() {
  const { data, error } = await adminClient
    .from("v2_aois")
    .insert({
      dataset_id: datasetId,
      user_id: reporterUser.id,
      geometry: machinePredictionGeometry,
      is_whole_image: false,
      source: "ml_prediction",
      notes: "Auto-generated by aoi_segmentation_v1",
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

  const aoiCard = card(page, "7. Area of Interest (AOI)");
  const drawButton = aoiCard.getByRole("button", { name: "Draw AOI Polygon" });
  if (await drawButton.isVisible()) {
    await drawButton.click();
  } else {
    await aoiCard.getByRole("button", { name: "Add" }).click();
  }

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

async function expectManualCorrectionSaved(
  expectedId?: number,
  expectedPolygonCount?: number,
  expectedMetadata?: { image_quality: number; notes: string },
) {
  let correctionId = 0;

  await expect
    .poll(async () => {
      const { data, error } = await adminClient
        .from("v2_aois")
        .select("id,source,corrected_from_aoi_id,geometry,image_quality,notes")
        .eq("dataset_id", datasetId)
        .eq("source", "manual_correction")
        .single();
      expect(error).toBeNull();
      correctionId = data.id as number;
      return {
        source: data.source,
        corrected_from_aoi_id: data.corrected_from_aoi_id,
        polygonCount: data.geometry?.coordinates?.length,
        image_quality: data.image_quality,
        notes: data.notes,
      };
    })
    .toMatchObject({
      source: "manual_correction",
      corrected_from_aoi_id: machinePredictionAoiId,
      ...(expectedPolygonCount === undefined ? {} : { polygonCount: expectedPolygonCount }),
      ...(expectedMetadata ?? {}),
    });

  if (expectedId) {
    expect(correctionId).toBe(expectedId);
  }
  return correctionId;
}

async function addManualCorrectionMetadata() {
  const { error } = await adminClient
    .from("v2_aois")
    .update({
      image_quality: 2,
      notes: "Auditor metadata to preserve",
    })
    .eq("id", manualCorrectionAoiId);

  expect(error).toBeNull();
}

async function readAuditLease() {
  const { data, error } = await adminClient
    .from("dataset_audit_locks")
    .select("holder_id,lease_id,expires_at")
    .eq("dataset_id", datasetId)
    .maybeSingle();
  expect(error).toBeNull();
  return data as { holder_id: string; lease_id: string; expires_at: string } | null;
}

async function expectAuditLeaseHolder(holderId: string | null) {
  await expect
    .poll(async () => {
      const lease = await readAuditLease();
      return lease && Date.parse(lease.expires_at) > Date.now() ? lease.holder_id : null;
    })
    .toBe(holderId);
}

async function setAuditLease(holderId: string, expiresInSeconds: number) {
  const { error } = await adminClient.from("dataset_audit_locks").upsert({
    dataset_id: datasetId,
    holder_id: holderId,
    lease_id: randomUUID(),
    expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  });
  expect(error).toBeNull();
}

async function openAuditDetail(page: Page) {
  await page.goto(`/dataset-audit/${datasetId}`);
  await dismissCookieBanner(page);
  await expect(
    page.getByRole("heading", { name: new RegExp(`Audit: ${datasetId}`) }),
  ).toBeVisible({ timeout: 20_000 });
}

// The audit map offers prediction edits only when a preferred model prediction exists.
async function seedDeadwoodPrediction() {
  const { count, error: countError } = await adminClient
    .from("v2_labels")
    .select("id", { count: "exact", head: true })
    .eq("dataset_id", datasetId)
    .eq("label_data", "deadwood");
  expect(countError).toBeNull();
  if (count) return;
  const { data: preference, error: preferenceError } = await adminClient
    .from("v2_model_preferences")
    .select("model_config")
    .eq("label_data", "deadwood")
    .single();
  expect(preferenceError).toBeNull();
  const { error } = await adminClient.from("v2_labels").insert({
    dataset_id: datasetId,
    user_id: reporterUser.id,
    label_source: "model_prediction",
    label_type: "semantic_segmentation",
    label_data: "deadwood",
    model_config: preference.model_config,
  });
  expect(error).toBeNull();
}

// Lease scenarios need a saved audit even when run on their own.
async function ensureSavedAudit() {
  const { error } = await adminClient.from("dataset_audit").upsert(
    {
      dataset_id: datasetId,
      audited_by: auditorUser.id,
      final_assessment: "no_issues",
      notes: "Auditor local write integration completed.",
    },
    { onConflict: "dataset_id", ignoreDuplicates: true },
  );
  expect(error).toBeNull();
}

async function readSavedAudit() {
  const { data, error } = await adminClient
    .from("dataset_audit")
    .select("notes,audited_by,reviewed_at,reviewed_by")
    .eq("dataset_id", datasetId)
    .single();
  expect(error).toBeNull();
  return data;
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
    .select("id,dataset_id,user_id,is_whole_image,source,corrected_from_aoi_id,geometry,notes")
    .eq("dataset_id", datasetId)
    .order("created_at");
  expect(aoiError).toBeNull();
  expect(aois).toHaveLength(2);
  expect(aois?.[0]).toMatchObject({
    id: machinePredictionAoiId,
    dataset_id: datasetId,
    source: "ml_prediction",
    corrected_from_aoi_id: null,
    geometry: machinePredictionGeometry,
    notes: "Auto-generated by aoi_segmentation_v1",
  });
  expect(aois?.[1]).toMatchObject({
    id: manualCorrectionAoiId,
    dataset_id: datasetId,
    user_id: auditorUser.id,
    is_whole_image: false,
    source: "manual_correction",
    corrected_from_aoi_id: machinePredictionAoiId,
  });
  expect(aois?.[1].geometry).toMatchObject({ type: "MultiPolygon" });

  await expectAuditLeaseHolder(null);

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
  await deleteRows("dataset_audit_locks", "dataset_id", datasetId);
  await deleteRows("dataset_audit", "dataset_id", datasetId);
  await deleteRows("v2_aois", "dataset_id", datasetId);
  await deleteRows("v2_labels", "dataset_id", datasetId);
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
