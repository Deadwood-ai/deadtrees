import { expect, test } from "@playwright/test";

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
    await page.goto("/dataset");

    await expect(page.getByTestId("dataset-archive-page")).toBeVisible();
    const firstDataset = page.getByTestId("dataset-list-item").first();
    await expect(firstDataset).toBeVisible({ timeout: 45_000 });

    await firstDataset.click({ position: { x: 12, y: 12 } });
    await expect(page).toHaveURL(/\/dataset\/\d+$/);
    await expect(page.getByTestId("dataset-detail-page")).toBeVisible({
      timeout: 45_000,
    });
  });

  test("releases index opens an available public release", async ({ page }) => {
    await page.goto("/releases");

    await expect(page.getByTestId("releases-page")).toBeVisible();
    await expect(page.getByTestId("release-card").first()).toBeVisible();

    await page.getByRole("button", { name: "Open release" }).first().click();
    await expect(page).toHaveURL(/\/releases\/[^/]+$/);
    await expect(page.getByTestId("release-detail-page")).toBeVisible({
      timeout: 30_000,
    });
  });
});
