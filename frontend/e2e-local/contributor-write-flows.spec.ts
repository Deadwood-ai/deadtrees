import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

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
const localMailpitUrl = process.env.LOCAL_MAILPIT_HTTP_PORT
  ? `http://127.0.0.1:${process.env.LOCAL_MAILPIT_HTTP_PORT}`
  : "http://127.0.0.1:54324";

type MailpitMessageSummary = {
  ID: string;
  Subject?: string;
  To?: Array<{ Address?: string }>;
};

type LocalSession = {
  access_token: string;
  user: {
    id: string;
    email?: string;
  };
};

const uniqueRunId = `${Date.now()}-${randomUUID()}`;
const contributorEmail = `local-write-${uniqueRunId}@example.com`;
const initialPassword = `Initial-${uniqueRunId}!`;
const resetPassword = `Reset-${uniqueRunId}!`;
const contributorName = "Local Write Contributor";
const uploadDoi = `https://doi.org/10.1234/deadtrees.local-write-${uniqueRunId}`;

let adminClient: SupabaseClient;
let anonClient: SupabaseClient;
const uploadedDatasetIds: number[] = [];
let contributorAccessToken = "";

test.describe("contributor local write flows", () => {
  test.skip(
    process.env.E2E_LOCAL_WRITE !== "1",
    "Set E2E_LOCAL_WRITE=1 and start local Supabase/API/Mailpit before running this write suite.",
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
    await expectLocalService(
      `${localMailpitUrl}/api/v1/info`,
      "local Supabase Mailpit",
    );
    await purgeMailpit();
    await deleteAuthUsersByEmail(adminClient, contributorEmail);
  });

  test.afterAll(async () => {
    await cleanupDatasets(adminClient, uploadedDatasetIds);
    await deleteAuthUsersByEmail(adminClient, contributorEmail);
    await purgeMailpit();
  });

  test("signup creates a local authenticated contributor", async ({ page }) => {
    await page.goto("/sign-up");

    await page.getByPlaceholder(/email/i).fill(contributorEmail);
    await page.getByPlaceholder(/password/i).fill(initialPassword);
    await page.getByRole("button", { name: /sign up/i }).click();

    await expect(page).toHaveURL(/\/profile$/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "My Account" }),
    ).toBeVisible();
    await expect(page.getByText(contributorEmail)).toBeVisible();

    const user = await waitForAuthUser(contributorEmail);
    expect(user.email).toBe(contributorEmail);
    expect(user.email_confirmed_at).toBeTruthy();
  });

  test("password reset sends local email and updates the credential", async ({
    page,
  }) => {
    await clearBrowserSession(page);
    await purgeMailpit();

    await page.goto("/forgot-password");
    await page.getByPlaceholder(/email/i).fill(contributorEmail);
    await page.getByRole("button", { name: /reset|send/i }).click();

    const recoveryLink = await waitForRecoveryLink(contributorEmail);
    expect(recoveryLink).toContain("/auth/v1/verify");
    expect(recoveryLink).toContain("type=recovery");

    await page.goto(recoveryLink);
    await expect(page).toHaveURL(/\/reset-password/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Reset Password" }),
    ).toBeVisible();

    await page.getByLabel(/^New Password$/i).fill(resetPassword);
    await page.getByLabel(/^Confirm New Password$/i).fill(resetPassword);
    await page.getByRole("button", { name: /^Reset Password$/i }).click();

    await expect(page).toHaveURL(/\/profile$/, { timeout: 20_000 });
    await expect(page.getByText(contributorEmail)).toBeVisible();

    const oldLogin = await anonClient.auth.signInWithPassword({
      email: contributorEmail,
      password: initialPassword,
    });
    expect(oldLogin.error?.message).toMatch(/invalid login credentials/i);

    const newLogin = await anonClient.auth.signInWithPassword({
      email: contributorEmail,
      password: resetPassword,
    });
    expect(newLogin.error).toBeNull();
    expect(newLogin.data.user?.email).toBe(contributorEmail);
    await anonClient.auth.signOut();
  });

  test("upload start writes dataset, storage object, and processing queue", async ({
    page,
  }) => {
    await signInContributor(page);
    await expect(
      page.getByRole("heading", { name: "My Account" }),
    ).toBeVisible();
    contributorAccessToken = await getBrowserAccessToken(page);

    const uploadResponsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${localApiUrl}/datasets/chunk` &&
        response.request().method() === "POST",
    );
    const processResponsePromise = page.waitForResponse(
      (response) =>
        /\/datasets\/\d+\/process$/.test(response.url()) &&
        response.request().method() === "PUT",
    );

    await page.getByRole("button", { name: "Upload Data" }).click();
    await page
      .getByTestId("contributor-upload-dropzone")
      .setInputFiles(rgbGeoTiffFixture);

    await addUploadAuthor(page, contributorName);

    const dateInput = page.getByPlaceholder("Select date");
    await dateInput.fill("2024-05-06");
    await dateInput.press("Enter");

    await page.getByLabel("DOI").fill(uploadDoi);
    await page
      .getByLabel("Additional Information")
      .fill("Local write-flow upload start");
    await page.getByRole("checkbox", { name: /I agree to the/i }).check();

    await expect(page.getByTestId("contributor-upload-submit")).toBeEnabled();
    await page.getByTestId("contributor-upload-submit").click();

    const uploadResponse = await uploadResponsePromise;
    expect(uploadResponse.status()).toBe(200);
    const uploadedDataset = await uploadResponse.json();
    const datasetId = Number(uploadedDataset.id);
    expect(datasetId).toBeGreaterThan(0);
    uploadedDatasetIds.push(datasetId);

    const processResponse = await processResponsePromise;
    expect(processResponse.status()).toBe(200);

    await expectDatasetSideEffects(datasetId);
  });

  test("download request creates a local bundle and download audit log", async ({
    request,
  }) => {
    const datasetId = uploadedDatasetIds.at(-1);
    expect(datasetId).toBeTruthy();
    expect(contributorAccessToken).toBeTruthy();

    await markUploadedDatasetDownloadable(datasetId!);

    const status = await startAndWaitForDatasetDownload(
      request,
      datasetId!,
      contributorAccessToken,
    );

    expect(status.download_path).toBe(
      `/downloads/v1/${datasetId}/${datasetId}.zip`,
    );

    const downloadFile = path.join(
      localDataRoot,
      "downloads",
      String(datasetId),
      `${datasetId}.zip`,
    );
    expect(fs.existsSync(downloadFile)).toBe(true);

    const { data: logs, error } = await adminClient
      .from("v2_logs")
      .select("id, category, dataset_id, extra")
      .eq("dataset_id", datasetId)
      .eq("category", "download");

    expect(error).toBeNull();
    expect(logs?.some((log) => log.extra?.event === "allowed")).toBe(true);
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
    throw new Error(`${name} must be set for the local write E2E suite.`);
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

async function clearBrowserSession(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

async function signInContributor(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder(/email/i).fill(contributorEmail);
  await page.getByPlaceholder(/password/i).fill(resetPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/, { timeout: 20_000 });
}

async function addUploadAuthor(page: Page, author: string) {
  const authorSelect = page.getByTestId("contributor-upload-author-select");
  await authorSelect.locator("input").fill(author);
  await authorSelect.locator("input").press("Enter");
  await expect(authorSelect).toContainText(author);
}

async function purgeMailpit() {
  const response = await fetch(`${localMailpitUrl}/api/v1/messages`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to purge Mailpit: ${response.status} ${await response.text()}`,
    );
  }
}

async function waitForAuthUser(email: string) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const user = await findAuthUserByEmail(adminClient, email);
    if (user) {
      return user;
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for local auth user ${email}`);
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

async function waitForRecoveryLink(email: string) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const summariesResponse = await fetch(`${localMailpitUrl}/api/v1/messages`);
    const summaries = await summariesResponse.json();
    const message = (summaries.messages as MailpitMessageSummary[]).find(
      (candidate) =>
        candidate.To?.some((recipient) => recipient.Address === email) &&
        /reset|recover|password/i.test(candidate.Subject ?? ""),
    );

    if (message) {
      const detailResponse = await fetch(
        `${localMailpitUrl}/api/v1/message/${message.ID}`,
      );
      const detail = await detailResponse.json();
      const body = [detail.HTML, detail.Text, detail.Snippet]
        .filter(Boolean)
        .join("\n")
        .replaceAll("&amp;", "&");
      const match = body.match(
        /https?:\/\/[^"'<>\s]+\/auth\/v1\/verify\?[^"'<>\s]+/,
      );

      if (match?.[0]) {
        return match[0];
      }
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for password recovery email to ${email}`);
}

async function expectDatasetSideEffects(datasetId: number) {
  const { data: datasetRows, error: datasetError } = await adminClient
    .from("v2_datasets")
    .select(
      "id, file_name, authors, data_access, citation_doi, aquisition_year, aquisition_month, aquisition_day",
    )
    .eq("id", datasetId);

  expect(datasetError).toBeNull();
  expect(datasetRows).toEqual([
    expect.objectContaining({
      id: datasetId,
      file_name: "rgb-real-crop.tif",
      authors: [contributorName],
      data_access: "public",
      citation_doi: uploadDoi,
      aquisition_year: 2024,
      aquisition_month: 5,
      aquisition_day: 6,
    }),
  ]);

  const { data: orthoRows, error: orthoError } = await adminClient
    .from("v2_orthos")
    .select("dataset_id, ortho_file_name")
    .eq("dataset_id", datasetId);

  expect(orthoError).toBeNull();
  expect(orthoRows).toEqual([]);

  const archiveFile = path.join(
    localDataRoot,
    "archive",
    `${datasetId}_ortho.tif`,
  );
  expect(fs.existsSync(archiveFile)).toBe(true);
  expect(fs.statSync(archiveFile).size).toBeGreaterThan(0);

  const { data: statusRows, error: statusError } = await adminClient
    .from("v2_statuses")
    .select("dataset_id, current_status, is_upload_done, has_error")
    .eq("dataset_id", datasetId);

  expect(statusError).toBeNull();
  expect(statusRows).toEqual([
    expect.objectContaining({
      dataset_id: datasetId,
      current_status: "idle",
      is_upload_done: true,
      has_error: false,
    }),
  ]);

  const { data: queueRows, error: queueError } = await adminClient
    .from("v2_queue")
    .select("dataset_id, task_types, priority, is_processing")
    .eq("dataset_id", datasetId);

  expect(queueError).toBeNull();
  expect(queueRows).toEqual([
    {
      dataset_id: datasetId,
      task_types: [
        "geotiff",
        "cog",
        "thumbnail",
        "metadata",
        "deadwood_v1",
        "treecover_v1",
        "deadwood_treecover_combined_v2",
      ],
      priority: 4,
      is_processing: false,
    },
  ]);
}

async function markUploadedDatasetDownloadable(datasetId: number) {
  const archiveFile = path.join(
    localDataRoot,
    "archive",
    `${datasetId}_ortho.tif`,
  );
  const fileSizeMb = Math.max(
    1,
    Math.ceil(fs.statSync(archiveFile).size / 1024 / 1024),
  );

  const { error: orthoError } = await adminClient.from("v2_orthos").insert({
    dataset_id: datasetId,
    ortho_file_name: `${datasetId}_ortho.tif`,
    version: 1,
    ortho_file_size: fileSizeMb,
    ortho_upload_runtime: 0.1,
  });
  expect(orthoError).toBeNull();

  const { error: statusError } = await adminClient
    .from("v2_statuses")
    .update({ is_ortho_done: true })
    .eq("dataset_id", datasetId);
  expect(statusError).toBeNull();
}

async function getBrowserAccessToken(page: Page) {
  const session = await page.evaluate(() => {
    const storageKey = Object.keys(window.localStorage).find(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    );

    if (!storageKey) {
      return null;
    }

    return JSON.parse(window.localStorage.getItem(storageKey) || "null");
  });

  expect(session).toBeTruthy();
  return (session as LocalSession).access_token;
}

async function startAndWaitForDatasetDownload(
  request: APIRequestContext,
  datasetId: number,
  accessToken: string,
) {
  const startResponse = await request.get(
    `${localApiUrl}/download/datasets/${datasetId}/dataset.zip`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  expect(startResponse.status()).toBe(200);
  const started = await startResponse.json();
  expect(started.job_id).toBe(String(datasetId));

  const deadline = Date.now() + 20_000;
  let lastStatus = started;

  while (Date.now() < deadline) {
    const statusResponse = await request.get(
      `${localApiUrl}/download/datasets/${datasetId}/status`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    expect(statusResponse.status()).toBe(200);
    lastStatus = await statusResponse.json();

    if (lastStatus.status === "completed") {
      return lastStatus;
    }

    if (lastStatus.status === "failed") {
      throw new Error(`Download failed: ${lastStatus.message}`);
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for dataset ${datasetId} download; last status: ${JSON.stringify(lastStatus)}`,
  );
}

async function cleanupDatasets(client: SupabaseClient, datasetIds: number[]) {
  for (const datasetId of datasetIds) {
    await client.from("v2_logs").delete().eq("dataset_id", datasetId);
    await client.from("v2_queue").delete().eq("dataset_id", datasetId);
    await client.from("v2_statuses").delete().eq("dataset_id", datasetId);
    await client.from("v2_orthos").delete().eq("dataset_id", datasetId);
    await client.from("v2_metadata").delete().eq("dataset_id", datasetId);
    await client.from("v2_datasets").delete().eq("id", datasetId);

    fs.rmSync(
      path.join(localDataRoot, "archive", `${datasetId}_ortho.tif`),
      {
        force: true,
      },
    );
    fs.rmSync(path.join(localDataRoot, "downloads", String(datasetId)), {
      force: true,
      recursive: true,
    });
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
