import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Local-only write suite for private dataset sharing: an owner shares a private
 * orthophoto with a named colleague, the colleague views it online through signed
 * file addresses, a stranger sees nothing, and revocation takes effect at once.
 * The owner finds the colleague by typing part of their email.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const localDataRoot = process.env.LOCAL_DATA_ROOT || path.join(repoRoot, "data");
const rgbGeoTiffFixture = path.resolve(__dirname, "../../assets/test_data/test-data-small.tif");

const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const localApiUrl = process.env.VITE_LOCAL_API_URL || "http://localhost:8080/api/v1";

const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const accounts = {
  owner: { email: `sharing-owner-${runId}@example.com`, password: `Owner-${runId}!` },
  colleague: { email: `sharing-colleague-${runId}@example.com`, password: `Colleague-${runId}!` },
  stranger: { email: `sharing-stranger-${runId}@example.com`, password: `Stranger-${runId}!` },
};
const cogRelativePath = `sharing-${runId}/${runId}_cog.tif`;
const privateCogFile = path.join(localDataRoot, "cogs", cogRelativePath);
const publicCogFile = path.join(localDataRoot, "cogs", cogRelativePath);

let adminClient: SupabaseClient;
let anonClient: SupabaseClient;
const users: Partial<Record<keyof typeof accounts, User>> = {};
let datasetId = 0;
let uploadedDatasetId = 0;

test.describe("private dataset sharing (local write)", () => {
  test.skip(
    process.env.E2E_LOCAL_SHARING_WRITE !== "1",
    "Set E2E_LOCAL_SHARING_WRITE=1 and start the isolated local stack before running this write suite.",
  );
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    for (const url of [localSupabaseUrl, localApiUrl]) {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
        throw new Error("Sharing write tests require local API and Supabase endpoints.");
      }
    }
    adminClient = localClient(requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    anonClient = localClient(process.env.VITE_SUPABASE_ANON_KEY || requireEnv("SUPABASE_ANON_KEY"));
    const api = await fetch(`${localApiUrl}/`);
    expect(api.ok, `local API reachable at ${localApiUrl}`).toBe(true);

    for (const [name, account] of Object.entries(accounts)) {
      const { data, error } = await adminClient.auth.admin.createUser({ ...account, email_confirm: true });
      if (error || !data.user) throw error ?? new Error(`could not create ${name}`);
      users[name as keyof typeof accounts] = data.user;
    }
    datasetId = await createPrivateDatasetWithCog(users.owner!.id);
  });

  test.afterAll(async () => {
    if (uploadedDatasetId) {
      await adminClient.from("v2_queue").delete().eq("dataset_id", uploadedDatasetId);
      await adminClient.from("v2_datasets").delete().eq("id", uploadedDatasetId);
      fs.rmSync(path.join(localDataRoot, "archive", `${uploadedDatasetId}_ortho.tif`), { force: true });
    }
    if (datasetId) await adminClient.from("v2_datasets").delete().eq("id", datasetId);
    for (const user of Object.values(users)) if (user) await adminClient.auth.admin.deleteUser(user.id);
    fs.rmSync(path.dirname(privateCogFile), { recursive: true, force: true });
    fs.rmSync(path.dirname(publicCogFile), { recursive: true, force: true });
  });

  test("ordinary user uploads a private orthophoto without a privilege flag", async ({ page }) => {
    const privileges = await adminClient.from("privileged_users").select("user_id").eq("user_id", users.owner!.id);
    expect(privileges.data).toEqual([]);
    await signIn(page, "owner");
    await page.goto("/profile");
    await page.getByRole("button", { name: "Upload Data" }).click();
    await page.getByTestId("contributor-upload-dropzone").setInputFiles(rgbGeoTiffFixture);
    const author = page.getByTestId("contributor-upload-author-select").locator("input");
    await author.fill("Local Sharing Owner");
    await author.press("Enter");
    const date = page.getByPlaceholder("Select date");
    await date.fill("2025-06-12");
    await date.press("Enter");
    await page.getByTestId("visibility-choice").getByText("Private", { exact: true }).click();
    await page.getByRole("checkbox", { name: /I agree to the/i }).check();
    const uploaded = page.waitForResponse(response => response.url() === `${localApiUrl}/datasets/chunk` && response.request().method() === "POST");
    const queued = page.waitForResponse(response => /\/datasets\/\d+\/process$/.test(response.url()) && response.request().method() === "PUT");
    await page.getByTestId("contributor-upload-submit").click();
    const response = await uploaded;
    expect(response.status()).toBe(200);
    uploadedDatasetId = Number((await response.json()).id);
    expect((await queued).status()).toBe(200);
    const row = await adminClient.from("v2_datasets").select("user_id,data_access").eq("id", uploadedDatasetId).single();
    expect(row.data).toEqual({ user_id: users.owner!.id, data_access: "private" });
    expect(fs.existsSync(path.join(localDataRoot, "archive", `${uploadedDatasetId}_ortho.tif`))).toBe(true);
  });

  test("owner shares the private dataset with a named colleague", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto("/profile");
    const row = page.locator("tr", { hasText: `sharing-${runId}.tif` });
    await row.getByRole("button", { name: /Actions/ }).click();
    await page.getByRole("menuitem", { name: /Share/ }).click();

    const dialog = page.getByRole("dialog", { name: /Share/ });
    // Part of the address is enough: the dialog suggests matching accounts.
    await dialog.getByLabel("Email").pressSequentially(`colleague-${runId.slice(0, 6)}`);
    // Ant Design's visible suggestion rows; its role="option" nodes are hidden a11y copies.
    const suggestions = page.locator(".ant-select-item-option");
    const suggestion = suggestions.filter({ hasText: accounts.colleague.email });
    await expect(suggestion).toBeVisible();
    await expect(suggestions.filter({ hasText: accounts.owner.email })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("0-owner-email-suggestion.png") });
    await suggestion.click();
    await expect(dialog.getByLabel("Email")).toHaveValue(accounts.colleague.email);
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dialog.getByText(accounts.colleague.email)).toBeVisible();
    await expect(dialog.getByText("Owner", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("1-owner-share-dialog.png") });
  });

  test("colleague finds it under Shared with me and views the orthophoto online", async ({ page }) => {
    const privateRanges: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes(`/datasets/${datasetId}/files/cog/`)) privateRanges.push(response.status());
    });
    const staticRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(cogRelativePath) && request.url().includes("/cogs/v1/")) staticRequests.push(request.url());
    });

    await signIn(page, "colleague");
    await page.goto("/profile");
    await page.getByText("Shared with me", { exact: true }).click();
    const shared = page.getByTestId("shared-with-me-table");
    await expect(shared.getByText("Reader")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("2-colleague-shared-with-me.png") });

    await shared.getByRole("link", { name: `sharing-${runId}.tif` }).click();
    await expect(page.getByTestId("dataset-access-section")).toContainText("Reader");
    await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
    await expect.poll(() => privateRanges.filter((status) => status === 206).length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(staticRequests).toEqual([]);
    await expect(page.getByTestId("dataset-download-section").getByRole("button", { name: "Download unavailable" })).toBeDisabled();
    await expect(page.locator("canvas").first()).toBeVisible();
    // The middle of this known imagery fixture must contain rendered texture.
    // A blue/blank map compresses to under 2 KB and previously passed HTTP checks.
    await page.mouse.move(640, 100);
    await expect.poll(async () => (await page.screenshot({
      clip: { x: 430, y: 180, width: 420, height: 360 },
    })).byteLength, { timeout: 20_000 }).toBeGreaterThan(15_000);
    await page.screenshot({ path: test.info().outputPath("3-colleague-private-map.png") });
  });

  test("a stranger and an anonymous visitor see no more than for a missing dataset", async ({ page }) => {
    const readNotFoundPage = async (id: number) => {
      await page.goto(`/dataset/${id}`);
      await expect(page.getByText("Dataset not found.")).toBeVisible();
      return (await page.locator("#root").innerText()).replaceAll(String(id), "ID");
    };
    const hiddenText = await readNotFoundPage(datasetId);
    await expect(page.getByTestId("dataset-access-section")).toHaveCount(0);
    expect(hiddenText).toBe(await readNotFoundPage(datasetId + 1_000_000));

    await signIn(page, "stranger");
    await page.goto(`/dataset/${datasetId}`);
    await expect(page.getByText("Dataset not found.")).toBeVisible();
    await expect(page.getByText(`sharing-${runId}.tif`)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("4-stranger-no-access.png") });
    expect((await fetch(`${localApiUrl.replace(/\/api\/v1$/, "")}/cogs/v1/${cogRelativePath}`)).status).toBe(403);
  });

  test("an editor changes the dataset's details but not who can see it", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto("/profile");
    const row = page.locator("tr", { hasText: `sharing-${runId}.tif` });
    await row.getByRole("button", { name: /Actions/ }).click();
    await page.getByRole("menuitem", { name: /Share/ }).click();
    const dialog = page.getByRole("dialog", { name: /Share/ });
    const roleSelect = page.getByRole("combobox", { name: `Access for ${accounts.colleague.email}` });
    await dialog.locator(".ant-select", { has: roleSelect }).click();
    await page.getByRole("option", { name: "Editor" }).click();
    await expect(page.getByText(`Access updated for ${accounts.colleague.email}`)).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "Can download", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("6-owner-makes-editor.png") });
    await page.keyboard.press("Escape");

    await signIn(page, "colleague");
    await page.goto(`/dataset/${datasetId}`);
    const access = page.getByTestId("dataset-access-section");
    await expect(access).toContainText("Editor");
    await expect(access.getByRole("button", { name: "Change visibility" })).toHaveCount(0);
    await access.getByRole("button", { name: "Edit details" }).click();
    const edit = page.getByRole("dialog", { name: /Edit/ });
    await edit.getByLabel("DOI").fill(`https://doi.org/10.5555/editor-${runId}`);
    await page.screenshot({ path: test.info().outputPath("7-editor-edits-details.png") });
    await edit.getByRole("button", { name: /Save/ }).click();
    await expect.poll(async () => (await adminClient.from("v2_datasets").select("citation_doi").eq("id", datasetId).single()).data?.citation_doi).toBe(`https://doi.org/10.5555/editor-${runId}`);
  });

  test("revoking access ends the colleague's view immediately", async ({ page }) => {
    const owner = await anonClient.auth.signInWithPassword(accounts.owner);
    const ownerClient = localClient(process.env.VITE_SUPABASE_ANON_KEY || requireEnv("SUPABASE_ANON_KEY"), owner.data.session!.access_token);
    const { error } = await ownerClient.rpc("revoke_dataset_access", { p_dataset_id: datasetId, p_user_id: users.colleague!.id });
    expect(error).toBeNull();

    await signIn(page, "colleague");
    await page.goto("/profile");
    await page.getByText("Shared with me", { exact: true }).click();
    await expect(page.getByTestId("shared-with-me-empty")).toBeVisible();
  });

  test("owner makes the dataset view-only without moving its files", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto("/profile");
    const row = page.locator("tr", { hasText: `sharing-${runId}.tif` });
    await row.getByRole("button", { name: /Actions/ }).click();
    await page.getByRole("menuitem", { name: /Change Visibility/ }).click();
    const dialog = page.getByRole("dialog", { name: /Who can see this dataset/ });
    await dialog.getByText("View only", { exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("5-owner-visibility-choice.png") });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).not.toBeVisible();
    const saved = await adminClient.from("v2_datasets").select("data_access").eq("id", datasetId).single();
    expect(saved.data?.data_access).toBe("viewonly");
    expect(fs.existsSync(publicCogFile)).toBe(true);
    // nginx caches the earlier refusal for up to a minute; a fresh URL shows the new answer.
    expect((await fetch(`${localApiUrl.replace(/\/api\/v1$/, "")}/cogs/v1/${cogRelativePath}?viewonly`)).status).toBe(200);
  });
});

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the local sharing write suite.`);
  return value;
}

function localClient(key: string, accessToken?: string) {
  return createClient(localSupabaseUrl, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

async function signIn(page: Page, who: keyof typeof accounts) {
  const login = await anonClient.auth.signInWithPassword(accounts[who]);
  expect(login.error).toBeNull();
  await page.addInitScript((session) => {
    window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
  }, login.data.session);
  await page.goto("/");
  await page.getByRole("button", { name: "Accept" }).click({ timeout: 2_000 }).catch(() => undefined);
}

async function createPrivateDatasetWithCog(ownerId: string) {
  const { data: dataset, error } = await adminClient
    .from("v2_datasets")
    .insert({
      file_name: `sharing-${runId}.tif`,
      user_id: ownerId,
      license: "CC BY",
      platform: "drone",
      authors: ["Local Sharing Owner"],
      data_access: "private",
      aquisition_year: 2025,
      aquisition_month: 6,
      aquisition_day: 12,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const id = dataset!.id as number;

  fs.mkdirSync(path.dirname(privateCogFile), { recursive: true });
  fs.copyFileSync(path.join(localDataRoot, "qa", "sharing-browser-cog.tif"), privateCogFile);
  const inserts = await Promise.all([
    adminClient.from("v2_statuses").insert({
      dataset_id: id,
      current_status: "idle",
      is_upload_done: true,
      is_ortho_done: true,
      is_cog_done: true,
      is_thumbnail_done: true,
      is_metadata_done: true,
      has_error: false,
    }),
    adminClient.from("v2_orthos").insert({
      dataset_id: id,
      ortho_file_name: `sharing-${runId}.tif`,
      version: 1,
      ortho_file_size: 1,
      ortho_upload_runtime: 0.1,
      // Extent of the real 512x512 imagery fixture.
      bbox: "BOX(7.769004166 47.794932706,7.769078502 47.795007042)",
    }),
    adminClient.from("v2_cogs").insert({
      dataset_id: id,
      cog_file_name: `${runId}_cog.tif`,
      version: 1,
      cog_file_size: 1,
      cog_info: {},
      cog_processing_runtime: 0.1,
      cog_path: cogRelativePath,
    }),
  ]);
  for (const insert of inserts) expect(insert.error).toBeNull();
  return id;
}
