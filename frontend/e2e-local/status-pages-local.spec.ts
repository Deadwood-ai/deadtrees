import { expect, test, type Page } from "@playwright/test";

import { acceptCookieConsent, installLocalSession } from "./support/localAuth";

// Full-page states share one card that must sit below the floating header.
async function expectCardClearOfHeader(page: Page, kind: string) {
  const card = page.getByTestId(`status-page-${kind}`);
  await expect(card).toBeVisible();
  const header = await page.locator(".dt-nav-shell:visible").first().boundingBox();
  const icon = await card.locator("h1").boundingBox();
  expect(icon!.y).toBeGreaterThan(header!.y + header!.height);
}

test.beforeEach(async ({ page }) => {
  await acceptCookieConsent(page);
});

test("an unknown URL shows a not-found page with navigation", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator(".dt-nav-shell:visible").first()).toBeVisible();
  await expectCardClearOfHeader(page, "not-found");
});

test("an invalid dataset ID answers at once instead of spinning", async ({ page }) => {
  await page.goto("/dataset/abc");
  await expect(page.getByRole("heading", { name: "Dataset not found" })).toBeVisible();
});

// /dataset/91003 is the seeded private contributor dataset (docs/qa/fixtures.md).
test("a private dataset offers signed-out visitors a sign-in that returns to it", async ({ page }) => {
  await page.goto("/dataset/91003");
  await expect(page.getByRole("heading", { name: "This dataset isn’t available" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in?returnTo=%2Fdataset%2F91003",
  );
});

test("an API outage on a dataset reads as an outage, not as not found", async ({ page }) => {
  await page.route("**/rest/v1/**", (route) => route.abort("connectionrefused"));
  await page.goto("/dataset/91001");
  await expect(page.getByRole("heading", { name: "This dataset couldn’t load" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a route chunk missing after a deploy reloads once, then explains the update", async ({ page }) => {
  // The dev server serves pages as source modules; production uses hashed chunks.
  await page.route(/\/src\/pages\/About\.tsx|\/assets\/About-.*\.js/, (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  let loads = 0;
  page.on("load", () => (loads += 1));
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "DeadTrees was just updated" })).toBeVisible();
  expect(loads).toBe(2);
  await expectCardClearOfHeader(page, "updated");
  await expect(page.getByRole("button", { name: "Reload page" })).toBeVisible();
});

test("an outage on My Account shows one retry instead of an empty table", async ({ page }) => {
  await installLocalSession(page, {
    user: { id: "00000000-0000-4000-8000-00000000a001", email: "qa-contributor-local@example.com" },
    supabaseUrl: process.env.VITE_SUPABASE_URL || "http://127.0.0.1:54321",
    refreshToken: "local-e2e-refresh",
  });
  await page.route("**/rest/v1/**", (route) => route.abort("connectionrefused"));
  await page.goto("/profile");
  await expect(page.getByTestId("my-datasets-error")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
  await expect(page.getByText("No data")).toHaveCount(0);
});

test("while a page's code loads, the footer stays below the screen", async ({ page }) => {
  // Hold the Home page module so the route loading state stays on screen.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/src\/pages\/Home\.tsx|\/assets\/Home-.*\.js/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Loading…" })).toBeVisible();
  const footer = await page.locator("footer").boundingBox();
  expect(footer!.y).toBeGreaterThanOrEqual(page.viewportSize()!.height);

  release();
  await expect(page.getByTestId("home-page")).toBeVisible();
});
