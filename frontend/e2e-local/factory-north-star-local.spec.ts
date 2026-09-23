import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

// The Factory overview: weekly north-star outcomes plus one attention pointer.
const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";

const operator = {
  id: "00000000-0000-4000-8000-0000000000c3",
  email: "operator-local-e2e@example.com",
};

const AS_OF = "2026-01-06T09:00:00Z";

const northStarWeeks = (includeTeam: boolean) =>
  Array.from({ length: 13 }, (_, index) => {
    const start = new Date(Date.UTC(2025, 9, 13 + index * 7)).toISOString();
    const end = new Date(Date.UTC(2025, 9, 20 + index * 7)).toISOString();
    const measured = index >= 6;
    const matured = measured && index <= 10;
    return {
      start, end, partial: index === 12,
      signups: 10, first_uploaders: 3, uploads: 40,
      results: measured ? (index === 11 ? (includeTeam ? 60 : 42) : 35) : null,
      reach_eligible: matured ? 40 : null,
      not_reached_7d: matured ? (index === 10 ? 6 : 10) : null,
      geotiff_p50_hours: measured ? (index === 11 ? 5 : 4) : null,
      geotiff_p90_hours: measured ? 27 : null,
      geotiff_samples: measured ? 30 : 0,
      odm_p50_hours: measured ? 20 : null, odm_p90_hours: measured ? 48 : null, odm_samples: measured ? 5 : 0,
      audited_usable: 12, published: 1,
      downloads: 50, reuse_downloads: index === 11 ? 44 : 40,
    };
  });

const northStar = (includeTeam: boolean) => ({
  as_of: AS_OF, include_team: includeTeam, team_accounts: 19,
  run_since: "2025-11-24T00:00:00Z", download_since: "2025-10-01T00:00:00Z",
  weekly: northStarWeeks(includeTeam),
  cohorts: Array.from({ length: 12 }, (_, index) => ({
    start: new Date(Date.UTC(2025, index, 1)).toISOString(), end: new Date(Date.UTC(2025, index + 1, 1)).toISOString(),
    signups: 40, activation_eligible: index <= 10 ? 40 : 0, activated_30d: index <= 10 ? (index === 10 ? 12 : 10) : 0,
    new_contributors: 10, retention_eligible: index <= 8 ? 10 : 0, returned_90d: index <= 8 ? 3 : 0,
  })),
  stalled: [
    { step: "segmentation", datasets: 7, with_error: 5 },
    { step: "late", datasets: 3, with_error: 0 },
  ],
  coverage: ["Team means accounts with auditor privileges."],
});

const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];

const fulfillJson = async (route: Route, json: unknown, status = 200) => {
  await route.fulfill({ status, contentType: "application/json", json });
};

const installNorthStar = async (page: Page, options: { malformed?: boolean } = {}) => {
  rpcCalls.length = 0;
  await installLocalSession(page, { user: operator, supabaseUrl: localSupabaseUrl, refreshToken: "local-operator-e2e-refresh-token" });
  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (segments.at(-2) === "rpc") rpcCalls.push({ name: segments.at(-1) ?? "", body });
    if (segments.at(-1) === "factory_north_star") {
      await fulfillJson(route, options.malformed ? { as_of: AS_OF } : northStar(body.p_include_team === true));
      return;
    }
    if (segments.at(-1) === "factory_operations") {
      await fulfillJson(route, { as_of: AS_OF, attention_total: 3, attention_contributors: 1, attention: [], waiting: [], coverage: [] });
      return;
    }
    if (segments.at(-1) === "privileged_users") {
      await fulfillJson(route, { id: 1, user_id: operator.id, can_upload_private: false, can_audit: false, can_view_all_private: false, can_operate: true, created_at: "2026-01-01T00:00:00Z" });
      return;
    }
    const wantsObject = route.request().headers()["accept"]?.includes("vnd.pgrst.object") ?? false;
    await fulfillJson(route, wantsObject ? null : []);
  });
};

const dismissCookieBanner = async (page: Page) => {
  await page.getByRole("button", { name: "Accept" }).click({ timeout: 2_000 }).catch(() => undefined);
};

test("overview answers whether the platform is doing its job, week over week", async ({ page }) => {
  await installNorthStar(page);
  await page.goto("/factory");
  await dismissCookieBanner(page);

  const headline = page.getByTestId("north-star-headline");
  await expect(headline.getByTestId("north-star-headline-value")).toHaveText("42");
  await expect(headline.getByTestId("north-star-change")).toHaveText("+7 vs previous week");
  await expect(headline.getByTestId("north-star-change")).toHaveAttribute("data-verdict", "good");
  await expect(headline).toContainText("external contributors only");
  if (process.env.FACTORY_SHOT_DIR) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${process.env.FACTORY_SHOT_DIR}/overview-desktop.png`, fullPage: true });
  }
  expect(rpcCalls.filter((call) => call.name === "factory_north_star").at(-1)?.body).toEqual({ p_include_team: false });

  const funnel = page.getByTestId("north-star-funnel").getByTestId("north-star-funnel-step");
  await expect(funnel).toHaveCount(7);
  await expect(funnel.nth(0).getByRole("link")).toHaveAttribute("href", "https://eu.posthog.com/web");
  await expect(funnel.nth(1)).toContainText("40Signups");
  await expect(funnel.nth(4)).toContainText("147Complete results");

  await expect(page.getByTestId("north-star-activation-value")).toHaveText("30%");
  await expect(page.getByTestId("north-star-activation")).toContainText("+5 pts vs previous cohort");
  await expect(page.getByTestId("north-star-missed-value")).toHaveText("15%");
  await expect(page.getByTestId("north-star-missed").getByTestId("north-star-change")).toHaveAttribute("data-verdict", "good");
  await expect(page.getByTestId("north-star-speed-value")).toHaveText("5 h");
  await expect(page.getByTestId("north-star-speed").getByTestId("north-star-change")).toHaveAttribute("data-verdict", "bad");
  await expect(page.getByTestId("north-star-retention-value")).toHaveText("30%");
  await expect(page.getByTestId("north-star-reuse-value")).toHaveText("44");
  await expect(page.getByTestId("north-star-reference-value")).toHaveText("12");
  await expect(page.getByTestId("north-star-stalled-step").first()).toContainText("Deadwood and forest-cover segmentation");
  await expect(page.getByTestId("north-star-stalled-step").first()).toContainText("(5 with error)");

  const attention = page.getByTestId("factory-attention-line");
  await expect(attention).toContainText("3 datasets need attention across 1 contributor.");
  await expect(page.getByTestId("factory-attention")).toHaveCount(0);

  await page.getByTestId("north-star-team-toggle").click();
  await expect(page).toHaveURL(/team=include/);
  await expect(headline.getByTestId("north-star-headline-value")).toHaveText("60");
  await expect(headline).toContainText("including team");
  expect(rpcCalls.filter((call) => call.name === "factory_north_star").at(-1)?.body).toEqual({ p_include_team: true });

  await expect(attention.getByRole("link", { name: "Open Operations →" })).toHaveAttribute("href", "/factory/operations");
});

test("a malformed north-star response is an error, never fabricated zeros", async ({ page }) => {
  await installNorthStar(page, { malformed: true });
  await page.goto("/factory");
  await dismissCookieBanner(page);
  await expect(page.getByTestId("factory-north-star")).toContainText("North-star outcomes returned an incomplete response.");
  await expect(page.getByTestId("north-star-headline")).toHaveCount(0);
  await expect(page.getByTestId("factory-attention-line")).toBeVisible();
});

test("overview reads well on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installNorthStar(page);
  await page.goto("/factory");
  await dismissCookieBanner(page);
  await expect(page.getByTestId("north-star-headline")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: process.env.FACTORY_SHOT_DIR ? `${process.env.FACTORY_SHOT_DIR}/overview-phone.png` : "test-results/overview-phone.png", fullPage: true });
});
