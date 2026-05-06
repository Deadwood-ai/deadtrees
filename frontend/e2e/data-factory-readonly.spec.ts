import { expect, test, type Page } from "@playwright/test";

const expectArchiveReady = async (page: Page) => {
  await expect(page.getByTestId("dataset-archive-page")).toBeVisible();
  const firstDataset = page.getByTestId("dataset-list-item").first();
  await expect(firstDataset).toBeVisible({ timeout: 45_000 });
  await expect(firstDataset).toContainText(/\S/);

  return firstDataset;
};

const expectReleasesReady = async (page: Page) => {
  await expect(page.getByTestId("releases-page")).toBeVisible();
  const releaseCards = page.getByTestId("release-card");
  await expect(releaseCards.first()).toBeVisible();

  return releaseCards;
};

test.describe("DeadTrees Data Factory read-only smoke", () => {
  test("public info and auth routes render their base read-only states", async ({
    page,
  }) => {
    const publicRoutes = [
      { path: "/about", heading: /^The Initiative$/i },
      {
        path: "/terms-of-service",
        heading: /^Nutzungsbedingungen \(Terms of Service\)$/i,
      },
      { path: "/datenschutzerklaerung", heading: /^Datenschutzerklärung$/i },
      { path: "/impressum", heading: /^Impressum$/i },
      { path: "/sign-up", heading: /^Sign Up$/i },
      { path: "/forgot-password", heading: /^Forgot Password$/i },
    ];

    for (const { path, heading } of publicRoutes) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }

    await page.goto("/profile");
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page).toHaveURL(/\/sign-up$/);
    await expect(page.getByRole("heading", { name: "Sign Up" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Already have an account?" }),
    ).toHaveAttribute("href", "/sign-in");

    await page.goto("/forgot-password");
    await expect(
      page.getByRole("heading", { name: /^Forgot Password$/i }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/sign-up");
  });

  test("contribution journey sends signed-out upload intent to authentication", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("home-page")).toBeVisible();
    await page.getByRole("button", { name: "Contribute Drone Data" }).click();

    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/sign-up");
  });

  test("archive journey finds public data and inspects the processed result", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(
      page.getByRole("img", { name: "deadtrees.earth" }).first(),
    ).toBeVisible();

    await page.getByRole("menuitem", { name: "Drone Archive" }).click();
    await expect(page).toHaveURL(/\/dataset$/);
    await expectArchiveReady(page);

    const searchInput = page.getByTestId("dataset-search-input");
    await searchInput.fill("no-matching-public-dataset-smoke-query");
    await expect(page.getByTestId("dataset-empty-results").first()).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(page.getByTestId("dataset-list-item")).toHaveCount(0, {
      timeout: 10_000,
    });

    await searchInput.clear();
    const firstDataset = await expectArchiveReady(page);

    const firstBiomeFilter = firstDataset.getByTestId("dataset-biome-filter");
    await expect(firstBiomeFilter).toBeVisible();
    await firstBiomeFilter.click();
    await expect(page.getByText("Filtered by:")).toBeVisible();
    await expectArchiveReady(page);
    await page.getByTestId("dataset-active-filter-clear").click();
    await expect(page.getByText("Filtered by:")).toHaveCount(0);
    const datasetAfterFilterClear = await expectArchiveReady(page);

    await datasetAfterFilterClear.click({ position: { x: 12, y: 12 } });
    await expect(page).toHaveURL(/\/dataset\/\d+$/);
    await expect(page.getByTestId("dataset-detail-page")).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByTestId("dataset-detail-map")).toBeVisible();
    await expect(
      page.locator('[data-testid="dataset-detail-map"] .ol-viewport'),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("dataset-layer-controls")).toBeVisible();
    await expect(page.getByTestId("dataset-download-section")).toBeVisible();
    await expect(
      page
        .getByTestId("dataset-download-section")
        .getByRole("button", { name: /Download/ }),
    ).toBeDisabled();

    for (const metadataLabel of ["Author", "Platform", "License"]) {
      await expect(page.getByText(metadataLabel).first()).toBeVisible();
    }

    const droneImageryLayer = page.getByRole("checkbox", {
      name: "Drone Imagery",
    });
    await expect(droneImageryLayer).toBeChecked();
    await droneImageryLayer.click();
    await expect(droneImageryLayer).not.toBeChecked();
    await droneImageryLayer.click();
    await expect(droneImageryLayer).toBeChecked();

    await page.getByTestId("dataset-detail-back-desktop").click();
    await expect(page).toHaveURL(/\/dataset$/);
    await expectArchiveReady(page);
  });

  test("release journey opens an available resource and exposes reuse metadata", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("menuitem", { name: "Releases" }).click();
    await expect(page).toHaveURL(/\/releases$/);
    const releaseCards = await expectReleasesReady(page);
    const releaseActions = page.getByRole("button", { name: "Open release" });
    const releaseActionCount = await releaseActions.count();

    for (let index = 0; index < releaseActionCount; index += 1) {
      const releaseAction = releaseActions.nth(index);

      if (!(await releaseAction.isEnabled())) {
        await expect(
          releaseAction.locator("xpath=ancestor::article[1]"),
        ).toContainText("Coming soon");
      }
    }

    const availableRelease = releaseCards
      .filter({ has: page.getByText("Available") })
      .first();
    await expect(availableRelease).toBeVisible();

    const releaseTitle = (await availableRelease.locator("h2").innerText())
      .trim()
      .replace(/\s+/g, " ");
    const openRelease = availableRelease.getByRole("button", {
      name: "Open release",
    });
    await expect(openRelease).toBeEnabled();
    await openRelease.click();

    await expect(page).toHaveURL(/\/releases\/[^/]+$/);
    await expect(page.getByTestId("release-detail-page")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      releaseTitle,
    );
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

  test("satellite map journey loads public layers and read-only controls", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Explore Map" }).click();
    await expect(page).toHaveURL(/\/deadtrees$/);
    await expect(page.getByTestId("deadtrees-map-page")).toBeVisible();
    await expect(page.getByTestId("deadtrees-map")).toBeVisible();
    await expect(
      page.locator('[data-testid="deadtrees-map"] .ol-viewport'),
    ).toBeVisible({ timeout: 45_000 });
    await page
      .getByRole("button", { name: "I Understand" })
      .click({ timeout: 5_000 })
      .catch(() => undefined);

    const controls = page.getByTestId("deadtrees-layer-controls");
    await expect(controls).toBeVisible();
    await expect(
      controls.getByRole("checkbox", { name: "Tree cover [%]" }),
    ).toBeChecked();
    const deadwoodLayer = controls.getByRole("checkbox", {
      name: "Deadwood cover [%]",
    });
    await expect(deadwoodLayer).toBeChecked();
    await deadwoodLayer.click();
    await expect(deadwoodLayer).not.toBeChecked();
    await deadwoodLayer.click();
    await expect(deadwoodLayer).toBeChecked();

    await expect(controls.getByText("Layer Opacity")).toBeVisible();
    await expect(controls.getByText("Model Info")).toBeVisible();
  });
});
