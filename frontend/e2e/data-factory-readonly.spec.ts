import { expect, test, type Page } from "@playwright/test";

const expectArchiveReady = async (page: Page) => {
  await expect(page.getByTestId("dataset-archive-page")).toBeVisible();
  const firstDataset = page.getByTestId("dataset-list-item").first();
  await expect(firstDataset).toBeVisible({ timeout: 45_000 });
  await expect(firstDataset).toContainText(/\S/);

  return firstDataset;
};

const waitForArchiveReadModelResponse = async (page: Page) =>
  page
    .waitForResponse(
      (response) =>
        response.url().includes("/rest/v1/public_dataset_archive_items"),
      { timeout: 20_000 },
    )
    .catch(() => null);

const skipIfArchiveReadModelMissing = (
  archiveResponse: Awaited<ReturnType<typeof waitForArchiveReadModelResponse>>,
) => {
  test.skip(
    archiveResponse?.status() === 404,
    "archive read-model migration has not been deployed to this backend yet",
  );

  expect(archiveResponse, "archive read-model request was not issued").not.toBeNull();
  expect(archiveResponse?.ok(), "archive read-model request failed").toBe(true);
};

const openArchiveFromHome = async (page: Page) => {
  await page.goto("/");

  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "deadtrees.earth" }).first(),
  ).toBeVisible();

  const archiveResponsePromise = waitForArchiveReadModelResponse(page);
  await page.getByRole("menuitem", { name: "Drone Archive" }).click();
  await expect(page).toHaveURL(/\/dataset$/);
  skipIfArchiveReadModelMissing(await archiveResponsePromise);

  return expectArchiveReady(page);
};

const expectReleasesReady = async (page: Page) => {
  await expect(page.getByTestId("releases-page")).toBeVisible();
  const releaseCards = page.getByTestId("release-card");
  await expect(releaseCards.first()).toBeVisible();

  return releaseCards;
};

test.describe("DeadTrees Data Factory read-only smoke", () => {
  test("homepage uses lightweight read models for stats and deferred teasers", async ({
    page,
  }) => {
    const restRequests: string[] = [];

    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/rest/v1/")) {
        restRequests.push(decodeURIComponent(url));
      }
    });

    const statsResponsePromise = page
      .waitForResponse((response) =>
        response.url().includes("/rest/v1/public_home_stats"),
      )
      .catch(() => null);

    await page.goto("/");

    const statsResponse = await statsResponsePromise;
    test.skip(
      statsResponse?.status() === 404,
      "homepage read-model migration has not been deployed to this backend yet",
    );

    expect(statsResponse, "home stats read-model request was not issued").not.toBeNull();
    expect(statsResponse?.ok(), "home stats read-model request failed").toBe(true);

    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("home-stat-datasets-value")).not.toHaveText(
      "...",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("home-stat-countries-value")).not.toHaveText(
      "...",
      { timeout: 20_000 },
    );
    await expect(
      page.getByTestId("home-stat-contributors-value"),
    ).not.toHaveText("...", { timeout: 20_000 });

    expect(
      restRequests.some((url) => url.includes("/rest/v1/public_home_stats")),
    ).toBe(true);
    expect(
      restRequests.some(
        (url) =>
          url.includes("/rest/v1/v2_full_dataset_view_public") &&
          url.includes("select=*"),
      ),
    ).toBe(false);
    expect(
      restRequests.some((url) =>
        url.includes("/rest/v1/public_home_dataset_teasers"),
      ),
    ).toBe(false);

    await page.getByTestId("home-data-gallery-anchor").scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          restRequests.some((url) =>
            url.includes("/rest/v1/public_home_dataset_teasers"),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
  });

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

  test("archive journey searches public data and applies a biome filter", async ({
    page,
  }) => {
    const restRequests: string[] = [];

    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/rest/v1/")) {
        restRequests.push(decodeURIComponent(url));
      }
    });

    await openArchiveFromHome(page);

    expect(
      restRequests.some((url) =>
        url.includes("/rest/v1/public_dataset_archive_items"),
      ),
    ).toBe(true);
    expect(
      restRequests.some(
        (url) =>
          url.includes("/rest/v1/v2_full_dataset_view_public") &&
          url.includes("select=*"),
      ),
    ).toBe(false);

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
    await expectArchiveReady(page);

    const firstBiomeFilter = page.getByTestId("dataset-biome-filter").first();
    await expect(firstBiomeFilter).toBeVisible();
    await firstBiomeFilter.click();
    await expect(page.getByText("Filtered by:")).toBeVisible();
    await expectArchiveReady(page);
    await page.getByTestId("dataset-active-filter-clear").click();
    await expect(page.getByText("Filtered by:")).toHaveCount(0);
    await expectArchiveReady(page);
  });

  test("dataset result journey inspects the processed result", async ({
    page,
  }) => {
    const firstDataset = await openArchiveFromHome(page);

    await firstDataset.click({ position: { x: 12, y: 12 } });
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
        .getByRole("button", {
          name: /Download dataset|Download ZIP|Sign in to download/,
        })
        .first(),
    ).toBeVisible();
  });

  test("release listing opens the drone mapping guide", async ({ page }) => {
    let feedbackRequestCount = 0;
    await page.route("https://formspree.io/f/xpqgllrn", async (route) => {
      feedbackRequestCount += 1;
      expect(route.request().method()).toBe("POST");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, next: "/thanks" }),
      });
    });

    await page.goto("/releases");

    const releaseCards = await expectReleasesReady(page);
    const guideCard = releaseCards
      .filter({
        has: page.getByRole("heading", { name: "Drone mapping guide" }),
      })
      .first();

    await expect(guideCard).toBeVisible();
    await expect(guideCard.getByText("Contributor guide")).toHaveCount(0);
    await expect(
      guideCard.getByText("Drone mapping", { exact: true }),
    ).toBeVisible();
    await expect(guideCard.getByText("Available")).toHaveCount(0);
    await expect(guideCard.getByText("4 steps")).toHaveCount(0);
    await expect(guideCard.getByText("Raw images")).toHaveCount(0);

    await guideCard.getByRole("button", { name: "Open guide" }).click();

    await expect(page).toHaveURL(/\/releases\/drone-mapping-guide$/);
    await expect(page.getByTestId("release-detail-page")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "How to plan a survey flight for forest mapping",
      }),
    ).toBeVisible();
    const workflow = page.getByTestId("drone-guide-workflow");
    await expect(workflow).toBeVisible();
    await expect(
      workflow.locator("details[open] summary").filter({
        hasText: "About the project",
      }),
    ).toBeVisible();
    await expect(page.getByText("Why do we need this data?")).toBeVisible();
    await workflow
      .locator("summary")
      .filter({ hasText: "Flight planning software" })
      .click();
    await expect(page.getByText("DJI Pilot 2")).toBeVisible();
    await expect(page.getByText("DJI Mavic Pro Series")).toBeVisible();
    await expect(page.getByText("DJI Matrice 400")).toBeVisible();
    await expect(page.getByText("...see all compatible drones.")).toHaveCount(2);
    await workflow
      .locator("summary")
      .filter({ hasText: "Planning & flying your mission" })
      .click();
    await expect(page.getByText("Front overlap")).toBeVisible();
    await expect(page.getByText("80–120m (relative to ground)")).toBeVisible();
    await expect(page.getByText("Wait for GPS lock")).toBeVisible();
    await expect(page.getByText("Battery management")).toBeVisible();
    await page.getByText("I have flight data").click();
    await expect(page.getByText("Acquisition date")).toBeVisible();
    await expect(page.getByText("Additional info")).toBeVisible();
    await expect(page.getByText("tree cover + dead trees layer")).toBeVisible();
    await expect(
      page.getByText("Come back when processing is complete"),
    ).toBeVisible();
    await workflow
      .locator("summary")
      .filter({ hasText: "Questions and feedback" })
      .click();
    await expect(page.getByText("Guide author")).toBeVisible();
    await expect(page.getByText("Sarah Habershon")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View Sarah’s RSC4Earth profile" }),
    ).toHaveAttribute(
      "href",
      "https://rsc4earth.de/author/sarah-habershon/",
    );
    await page.getByLabel("Your email").fill("codex-feedback-test@example.com");
    await page.getByLabel("Your question or feedback").fill("test feedback");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("Thanks — we'll get back to you soon."),
    ).toBeVisible();
    await expect(page.getByLabel("Your email")).toHaveValue("");
    await expect(page.getByLabel("Your question or feedback")).toHaveValue("");
    expect(feedbackRequestCount).toBe(1);
    await expect(page.getByTestId("release-artifacts")).toHaveCount(0);
  });

  test("satellite map journey loads public layers and read-only controls", async ({
    page,
  }) => {
    const earlyWaybackMetadataRequests: string[] = [];

    page.on("request", (request) => {
      const url = request.url();
      if (
        url.toLowerCase().includes("wayback") &&
        url.toLowerCase().includes("metadata")
      ) {
        earlyWaybackMetadataRequests.push(url);
      }
    });

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
    expect(earlyWaybackMetadataRequests).toHaveLength(0);
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
