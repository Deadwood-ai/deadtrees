import { expect, test } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";

test("signing out replaces private-inclusive home stats with public totals", async ({ page }) => {
  const session = await installLocalSession(page, {
    user: { id: "00000000-0000-4000-8000-0000000000c3", email: "stats-e2e@example.com" },
    supabaseUrl,
    refreshToken: "stats-local-test",
    acceptCookies: true,
  });
  await page.route(`${supabaseUrl}/auth/v1/logout*`, route => route.fulfill({ status: 204 }));
  await page.route(`${supabaseUrl}/rest/v1/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/public_home_stats")) {
      const signedIn = route.request().headers().authorization === `Bearer ${session.access_token}`;
      await route.fulfill({ json: {
        dataset_count: signedIn ? 12345 : 6789,
        country_count: signedIn ? 135 : 134,
        contributor_count: signedIn ? 2 : 1,
        contributor_names: signedIn ? ["Public Author", "Private Author"] : ["Public Author"],
        area_covered_ha: 10,
        data_size_tb: 1,
      } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  await page.goto("/");
  await expect(page.getByText("12,345", { exact: true })).toBeVisible();
  await page.getByText("Who is behind deadtrees.earth?", { exact: true }).click();
  await expect(page.getByText("Private Author, Public Author", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign Out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Home", exact: true }).click();
  await expect(page.getByText("6,789", { exact: true })).toBeVisible();
  await page.getByText("Who is behind deadtrees.earth?", { exact: true }).click();
  await expect(page.getByText("Public Author", { exact: true })).toBeVisible();
  await expect(page.getByText("12,345", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Private Author, Public Author", { exact: true })).toHaveCount(0);
});
