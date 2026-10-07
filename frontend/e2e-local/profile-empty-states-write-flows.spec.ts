import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { acceptCookieConsent } from "./support/localAuth";

/**
 * Local-only suite: a brand-new account sees the shared empty state on every
 * account tab, on desktop and on the narrow mobile layout. It creates one
 * throwaway user and deletes it afterwards.
 */

const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
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

test.describe("account empty states (local write)", () => {
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
    await page.goto("/profile");

    for (const { tab, testId, title, action } of tabs) {
      await page.getByText(tab, { exact: true }).click();
      const panel = page.getByTestId(testId);
      await expect(panel.getByRole("heading", { name: title })).toBeVisible();
      if (action) await expect(panel.getByRole("button", { name: action })).toBeVisible();
      await expect(page.locator(".ant-segmented-item-selected")).toHaveText(tab);
      await page.screenshot({ path: test.info().outputPath(`desktop-${testId}.png`), fullPage: true });
    }

    // The publications action leads back to the dataset list, where publishing starts.
    await page.getByText("Published Datasets", { exact: true }).click();
    await page.getByRole("button", { name: "Choose datasets to publish" }).click();
    await expect(page.getByTestId("my-datasets-empty")).toBeVisible();
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

async function signIn(page: Page) {
  const login = await anonClient.auth.signInWithPassword(account);
  expect(login.error).toBeNull();
  await acceptCookieConsent(page);
  await page.addInitScript((session) => {
    window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
  }, login.data.session);
}
