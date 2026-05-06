import { expect, test, type Page } from "@playwright/test";

const openFirstPublicDataset = async (page: Page) => {
  await page.goto("/dataset");

  await expect(page.getByTestId("dataset-archive-page")).toBeVisible();
  const firstDataset = page.getByTestId("dataset-list-item").first();
  await expect(firstDataset).toBeVisible({ timeout: 45_000 });

  await firstDataset.click({ position: { x: 12, y: 12 } });
  await expect(page).toHaveURL(/\/dataset\/\d+$/);
  await expect(page.getByTestId("dataset-detail-page")).toBeVisible({
    timeout: 45_000,
  });
};

const openFirstAvailableRelease = async (page: Page) => {
  await page.goto("/releases");

  await expect(page.getByTestId("releases-page")).toBeVisible();
  await expect(page.getByTestId("release-card").first()).toBeVisible();

  const releaseActions = page.getByRole("button", { name: "Open release" });
  const releaseActionCount = await releaseActions.count();

  for (let index = 0; index < releaseActionCount; index += 1) {
    const releaseAction = releaseActions.nth(index);

    if (await releaseAction.isEnabled()) {
      await releaseAction.click();
      await expect(page).toHaveURL(/\/releases\/[^/]+$/);
      await expect(page.getByTestId("release-detail-page")).toBeVisible({
        timeout: 30_000,
      });
      return;
    }
  }

  throw new Error("No available release action found.");
};

test.describe("customer factory public smoke", () => {
  test("home loads and primary navigation reaches core public routes", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(
      page.getByRole("img", { name: "deadtrees.earth" }).first(),
    ).toBeVisible();

    await page.getByRole("menuitem", { name: "Drone Archive" }).click();
    await expect(page).toHaveURL(/\/dataset$/);
    await expect(page.getByTestId("dataset-archive-page")).toBeVisible();

    await page.getByRole("menuitem", { name: "Releases" }).click();
    await expect(page).toHaveURL(/\/releases$/);
    await expect(page.getByTestId("releases-page")).toBeVisible();
  });

  test("dataset archive loads production data and opens a public dataset", async ({
    page,
  }) => {
    await openFirstPublicDataset(page);
  });

  test("dataset detail exposes result map metadata and layer controls", async ({
    page,
  }) => {
    await openFirstPublicDataset(page);

    await expect(page.getByTestId("dataset-detail-map")).toBeVisible();
    await expect(
      page.locator('[data-testid="dataset-detail-map"] .ol-viewport'),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("dataset-layer-controls")).toBeVisible();
    await expect(page.getByText("Author").first()).toBeVisible();
    await expect(page.getByText("Platform").first()).toBeVisible();
    await expect(page.getByText("License").first()).toBeVisible();

    const droneImageryLayer = page.getByRole("checkbox", {
      name: "Drone Imagery",
    });
    await expect(droneImageryLayer).toBeChecked();
    await droneImageryLayer.click();
    await expect(droneImageryLayer).not.toBeChecked();
    await droneImageryLayer.click();
    await expect(droneImageryLayer).toBeChecked();
  });

  test("dataset archive search handles empty results and recovers", async ({
    page,
  }) => {
    await page.goto("/dataset");

    await expect(page.getByTestId("dataset-archive-page")).toBeVisible();
    await expect(page.getByTestId("dataset-list-item").first()).toBeVisible({
      timeout: 45_000,
    });

    const searchInput = page.getByPlaceholder(
      "Search by Authors or Location (Region, Province, City)",
    );
    await searchInput.fill("no-matching-public-dataset-smoke-query");
    await expect(page.getByText("No results found").first()).toBeVisible({
      timeout: 10_000,
    });

    await searchInput.clear();
    await expect(page.getByTestId("dataset-list-item").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("releases index opens an available public release", async ({ page }) => {
    await openFirstAvailableRelease(page);
  });

  test("release detail exposes reusable public artifact metadata", async ({
    page,
  }) => {
    await openFirstAvailableRelease(page);

    await expect(page.getByTestId("release-artifacts")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: /Dataset package|Get the current package/,
      }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("release-artifacts")
        .getByRole("button", { name: /Download dataset|Download ZIP/ })
        .first(),
    ).toBeVisible();
  });
});
