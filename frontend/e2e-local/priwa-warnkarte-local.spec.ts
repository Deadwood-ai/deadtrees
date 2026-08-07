import { expect, test, type Page, type Route } from "@playwright/test";

import { installLocalSession } from "./support/localAuth";

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";
const admin = {
  id: "00000000-0000-4000-8000-0000000000c3",
  email: "priwa-warnkarte-admin@example.com",
};
const projectId = "00000000-0000-4000-8000-0000000000d4";

const polygon = {
  type: "Feature" as const,
  properties: { probability: 0.6 },
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [8.1, 48.4],
        [8.2, 48.4],
        [8.2, 48.5],
        [8.1, 48.4],
      ],
    ],
  },
};

async function installWarnkarteAdmin(page: Page) {
  await installLocalSession(page, {
    user: admin,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "priwa-warnkarte-refresh-token",
  });

  await page.route(`${localSupabaseUrl}/rest/v1/**`, fulfillSupabaseRequest);
}

async function fulfillSupabaseRequest(route: Route) {
  const url = new URL(route.request().url());
  const resource = url.pathname.split("/").filter(Boolean).at(-1);

  if (url.pathname.includes("/rpc/")) {
    await route.fulfill({ contentType: "application/json", json: [] });
    return;
  }

  if (resource === "privileged_users") {
    await route.fulfill({
      contentType: "application/json",
      json: {
        user_id: admin.id,
        can_upload_private: false,
        can_audit: false,
        can_view_all_private: false,
      },
    });
    return;
  }

  if (resource === "priwa_project_memberships") {
    await route.fulfill({
      contentType: "application/json",
      json: [
        {
          project_id: projectId,
          role: "admin",
          created_at: "2024-01-01T00:00:00Z",
          priwa_projects: {
            id: projectId,
            slug: "warnkarte-local",
            name: "Warnkarte Local",
          },
        },
      ],
    });
    return;
  }

  await route.fulfill({
    contentType: "application/json",
    headers: { "content-range": "0-0/0" },
    json: [],
  });
}

async function installWarnkarteApi(
  page: Page,
  { validateDelayMs = 0 }: { validateDelayMs?: number } = {},
) {
  let published = false;

  await page.route("**/priwa/warnkarte/active?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        version_id: null,
        source_date: published ? "2024-07-01" : "2024-06-25",
        type: "FeatureCollection",
        features: [polygon],
      },
    });
  });
  await page.route("**/priwa/warnkarte/versions?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: [
        {
          id: "version-new",
          source_date: "2024-07-01",
          source_filename: "warnkarte_2024-07-01.gpkg",
          checksum_sha256: "b".repeat(64),
          source_layer: "warning_polygons",
          source_crs: "EPSG:32632",
          feature_count: 1,
          imported_by: admin.id,
          imported_at: "2024-07-01T12:00:00Z",
          is_current: published,
        },
        {
          id: "version-old",
          source_date: "2024-06-25",
          source_filename: "warnkarte_2024-06-25.gpkg",
          checksum_sha256: "a".repeat(64),
          source_layer: "warning_polygons",
          source_crs: "EPSG:32632",
          feature_count: 1,
          imported_by: admin.id,
          imported_at: "2024-06-25T12:00:00Z",
          is_current: !published,
        },
      ],
    });
  });
  await page.route("**/priwa/warnkarte/validate", async (route) => {
    if (validateDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, validateDelayMs));
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        source_filename: "warnkarte_2024-07-01.gpkg",
        checksum_sha256: "b".repeat(64),
        authoritative_date: "2024-07-01",
        layer: "warning_polygons",
        crs: "EPSG:32632",
        feature_count: 1,
        warnings: [],
      },
    });
  });
  await page.route("**/priwa/warnkarte/import", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        version_id: "version-new",
        summary: {
          source_filename: "warnkarte_2024-07-01.gpkg",
          checksum_sha256: "b".repeat(64),
          authoritative_date: "2024-07-01",
          layer: "warning_polygons",
          crs: "EPSG:32632",
          feature_count: 1,
          warnings: [],
        },
      },
    });
  });
  await page.route(
    "**/priwa/warnkarte/versions/version-new/overlay?*",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          version_id: "version-new",
          source_date: "2024-07-01",
          type: "FeatureCollection",
          features: [polygon],
        },
      });
    },
  );
  await page.route(
    "**/priwa/warnkarte/versions/version-new/publish",
    async (route) => {
      published = true;
      await route.fulfill({
        contentType: "application/json",
        json: { publication_id: 2, version_id: "version-new" },
      });
    },
  );
}

test.describe("PRIWA Warnkarte local UI", () => {
  test("desktop admin validates, confirms, previews, and explicitly publishes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    await expect(page.getByText("Warnkarte vom 25.06.2024")).toBeVisible();
    const warnkarteControl = page
      .locator(".priwa-map-control-stack")
      .getByRole("button", { name: "Warnkarte verwalten" });
    await expect(warnkarteControl).toBeVisible();
    await expect(warnkarteControl).toHaveClass(/ant-btn-circle/);
    await warnkarteControl.click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "warnkarte_2024-07-01.gpkg",
      mimeType: "application/geopackage+sqlite3",
      buffer: Buffer.from("mocked direct geopackage"),
    });
    await expect(
      page.getByRole("button", { name: "Datei validieren" }),
    ).toHaveCount(0);
    await expect(page.getByText("01.07.2024", { exact: true })).toBeVisible();
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", {
        name: "Unveröffentlicht importieren und Vorschau öffnen",
      })
      .click();
    await expect(
      page.getByText(/Vorschau · Warnkarte vom 01.07.2024/),
    ).toBeVisible();

    const newVersion = page.getByText("Warnkarte vom 01.07.2024").last();
    const versionRow = newVersion.locator("xpath=ancestor::li");
    await versionRow.getByRole("button", { name: "Veröffentlichen" }).click();
    await page
      .getByRole("button", { name: "Veröffentlichen", exact: true })
      .last()
      .click();
    await expect(page.getByText("Warnkarte veröffentlicht.")).toBeVisible();
    await expect(page.getByText(/Vorschau ·/)).toHaveCount(0);
    await expect(
      page.getByText("Warnkarte vom 01.07.2024").first(),
    ).toBeVisible();
  });

  test("desktop admin cannot replace a file while its validation is pending", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page, { validateDelayMs: 750 });
    await page.goto("/priwa-field");

    await page.getByRole("button", { name: "Warnkarte verwalten" }).click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "warnkarte_2024-07-01.gpkg",
      mimeType: "application/geopackage+sqlite3",
      buffer: Buffer.from("mocked direct geopackage"),
    });

    await expect(fileInput).toBeDisabled();
    await expect(page.getByText("GeoPackage wird validiert …")).toBeVisible();
    await expect(page.getByText("01.07.2024", { exact: true })).toBeVisible();
    await expect(fileInput).toBeEnabled();
  });

  test("desktop preview explains when Warnkarte API routes are not deployed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    const unavailable = (route: Route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        json: { detail: "Not Found" },
      });
    await page.route("**/priwa/warnkarte/versions?*", unavailable);
    await page.route("**/priwa/warnkarte/validate", unavailable);
    await page.goto("/priwa-field");

    await page.getByRole("button", { name: "Warnkarte verwalten" }).click();
    const explanation =
      "Die Warnkarten-Funktion ist in dieser Vorschau noch nicht verfügbar. Die Datei wurde nicht validiert.";
    await expect(page.getByText(explanation)).toHaveCount(1);

    await page.locator('input[type="file"]').setInputFiles({
      name: "warnkarte_2024-07-01.gpkg",
      mimeType: "application/geopackage+sqlite3",
      buffer: Buffer.from("mocked direct geopackage"),
    });

    await expect(page.getByText(explanation)).toHaveCount(2);
    await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0);
  });

  test("mobile shows the published overlay label without management controls", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    await expect(page.getByText("Warnkarte vom 25.06.2024")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Warnkarte verwalten" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();
  });
});
