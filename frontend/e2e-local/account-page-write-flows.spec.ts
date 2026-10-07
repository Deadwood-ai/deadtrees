import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { acceptCookieConsent } from "./support/localAuth";

/**
 * Local-only suite for the account page. A brand-new account sees the getting
 * started strip and the shared empty state on every tab (desktop and mobile);
 * the seeded contributor sees their numbers and tab counts. The open tab lives
 * in the URL. It creates one throwaway user and deletes it afterwards.
 */

const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
// Seeded by scripts/qa fixtures (local only).
const seededContributor = { email: "qa-contributor-local@example.com", password: "DeadTreesQA-Local-1!" };
const account = { email: `empty-account-${runId}@example.com`, password: `Empty-${runId}!` };

let adminClient: SupabaseClient;
let anonClient: SupabaseClient;
let user: User | undefined;

const tabs = [
  { tab: "My Datasets", testId: "my-datasets-empty", title: "Map deadwood in your drone imagery", action: "Upload your first dataset" },
  { tab: "Shared with me", testId: "shared-with-me-empty", title: "Nothing shared with you yet" },
  { tab: "Published Datasets", testId: "publications-empty", title: "Get a citable DOI for your data", action: "Choose datasets to publish" },
  { tab: "My Issues", testId: "my-issues-empty", title: "Help us fix flawed results" },
];

test.describe("account page (local write)", () => {
  test.skip(
    process.env.E2E_LOCAL_WRITE !== "1",
    "Set E2E_LOCAL_WRITE=1 and start the isolated local stack before running this write suite.",
  );

  test.beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(localSupabaseUrl).hostname)) {
      throw new Error("Account empty-state tests require a local Supabase endpoint.");
    }
    adminClient = localClient(requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    anonClient = localClient(process.env.VITE_SUPABASE_ANON_KEY || requireEnv("SUPABASE_ANON_KEY"));
    const { data, error } = await adminClient.auth.admin.createUser({ ...account, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("could not create the empty account");
    user = data.user;
  });

  test.afterAll(async () => {
    if (user) await adminClient.auth.admin.deleteUser(user.id);
  });

  test("every desktop tab shows the shared empty state", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const thirdPartyAvatars: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("dicebear")) thirdPartyAvatars.push(request.url());
    });
    await page.goto("/profile");

    for (const { tab, testId, title, action } of tabs) {
      await page.getByText(tab, { exact: true }).click();
      const panel = page.getByTestId(testId);
      await expect(panel.getByRole("heading", { name: title })).toBeVisible();
      if (action) await expect(panel.getByRole("button", { name: action })).toBeVisible();
      await expect(page.locator(".ant-segmented-item-selected")).toHaveText(tab);
      await page.screenshot({ path: test.info().outputPath(`desktop-${testId}.png`), fullPage: true });
    }

    // The journey strip explains the steps until the first upload, and the avatar is drawn locally.
    await expect(page.getByTestId("journey-getting-started")).toBeVisible();

    // The publications action leads back to the dataset list, where publishing starts.
    await page.getByText("Published Datasets", { exact: true }).click();
    await page.getByRole("button", { name: "Choose datasets to publish" }).click();
    await expect(page.getByTestId("my-datasets-empty")).toBeVisible();
    expect(thirdPartyAvatars).toEqual([]);
  });

  test("the open tab is kept in the URL, across reloads and the back button", async ({ page }) => {
    await signIn(page);
    await page.goto("/profile");
    await page.getByText("My Issues", { exact: true }).click();
    await expect(page).toHaveURL(/\/profile\?tab=issues$/);
    await page.reload();
    await expect(page.getByTestId("my-issues-empty")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByTestId("my-datasets-empty")).toBeVisible();

    await page.goto("/profile?tab=shared");
    await expect(page.getByTestId("shared-with-me-empty")).toBeVisible();
    await page.goto("/profile?tab=unknown");
    await expect(page.getByTestId("my-datasets-empty")).toBeVisible();
  });

  test("the seeded contributor sees their numbers and tab counts", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, seededContributor);
    await page.goto("/profile");
    await expect(page.getByTestId("journey-upload")).toContainText("4");
    await expect(page.getByTestId("journey-upload")).toContainText("datasets uploaded");
    await expect(page.getByTestId("journey-process")).toContainText("with results ready");
    await expect(page.getByTestId("journey-publish")).toContainText("with a DOI");
    await expect(page.getByTestId("journey-getting-started")).toHaveCount(0);
    await expect(page.locator(".ant-segmented-item").filter({ hasText: "My Datasets" })).toContainText("4");
    await page.getByRole("button", { name: "What can I upload?" }).click();
    await expect(page.getByText("drone mapping guide")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("desktop-contributor-overview.png"), fullPage: true });
  });

  test("the mobile dataset list shows the empty state without an upload button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto("/profile");
    const panel = page.getByTestId("my-datasets-empty");
    await expect(panel.getByRole("heading", { name: tabs[0].title })).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("mobile-my-datasets-empty.png"), fullPage: true });
  });
});

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the local account empty-state suite.`);
  return value;
}

function localClient(key: string) {
  return createClient(localSupabaseUrl, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function signIn(page: Page, credentials: { email: string; password: string } = account) {
  const login = await anonClient.auth.signInWithPassword(credentials);
  expect(login.error).toBeNull();
  await acceptCookieConsent(page);
  await page.addInitScript((session) => {
    window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
  }, login.data.session);
}
