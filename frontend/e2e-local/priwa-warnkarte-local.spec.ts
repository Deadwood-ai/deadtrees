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
const treeId = "00000000-0000-4000-8000-0000000000d6";

const polygon = {
  type: "Feature" as const,
  properties: { probability: 0.6 },
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [8.32, 48.54],
        [8.38, 48.54],
        [8.38, 48.58],
        [8.32, 48.58],
        [8.32, 48.54],
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

  if (resource === "priwa_befallsgruppen") {
    await route.fulfill({
      contentType: "application/json",
      json: [
        {
          id: "00000000-0000-4000-8000-0000000000d5",
          project_id: projectId,
          name: "Befallsgruppe Test",
          origin: "manual",
          confidence: null,
          suggestion_reason: null,
          algorithm_version: null,
          created_at: "2024-06-25T12:00:00Z",
          updated_at: "2024-06-25T12:00:00Z",
          priwa_befallsgruppe_members: [{ tree_id: treeId, source: "manual" }],
          priwa_befallsgruppe_flights: [],
        },
      ],
    });
    return;
  }

  if (resource === "priwa_kaeferbaeume") {
    await route.fulfill({
      contentType: "application/json",
      json: [
        {
          id: treeId,
          project_id: projectId,
          geom: { type: "Point", coordinates: [8.15, 48.45] },
          location_source: "qr_exact",
          is_exact_location: true,
          baumnr: "53022",
          fund: "ja",
          baumart: "Fichte",
          bm: "ja",
          bohrloch: "ja",
          harz: "nein",
          gruene_nadeln_am_boden: "nein",
          nadel: "grün",
          rinde: "0%",
          kv: "0%",
          name: "Sigi Huber",
          datum: "2024-06-25",
          kom: null,
          raw_qr_value: null,
          created_at: "2024-06-25T12:00:00Z",
          updated_at: "2024-06-25T12:00:00Z",
          client_updated_at: "2024-06-25T12:00:00Z",
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
  {
    validateDelayMs = 0,
    overlayDelayMs = 0,
  }: { validateDelayMs?: number; overlayDelayMs?: number } = {},
) {
  let published = false;
  let archived = false;

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
          is_archived: archived,
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
          is_archived: false,
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
      if (overlayDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, overlayDelayMs));
      }
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
  await page.route(
    "**/priwa/warnkarte/versions/version-new/archive",
    async (route) => {
      archived = true;
      await route.fulfill({
        contentType: "application/json",
        json: { version_id: "version-new", is_archived: true },
      });
    },
  );
  await page.route(
    "**/priwa/warnkarte/versions/version-new/restore",
    async (route) => {
      archived = false;
      await route.fulfill({
        contentType: "application/json",
        json: { version_id: "version-new", is_archived: false },
      });
    },
  );
}

test.describe("PRIWA Warnkarte local UI", () => {
  test("desktop admin selects, validates, confirms, and explicitly publishes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 25.06.2024",
    );
    const warnkarteControl = page
      .locator(".priwa-map-control-stack")
      .getByRole("button", { name: "Warnkarte verwalten" });
    const visibilityControl = page
      .locator(".priwa-map-control-stack")
      .getByRole("button", { name: "Warnkarte ausblenden" });
    await expect(visibilityControl).toHaveAttribute("aria-pressed", "true");
    const zoomToWarnkarte = page.getByRole("button", {
      name: "Zur Warnkarte zoomen",
    });
    await expect(zoomToWarnkarte).toBeVisible();
    await visibilityControl.click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toHaveCount(0);
    await expect(zoomToWarnkarte).toHaveCount(0);
    await page.getByRole("button", { name: "Warnkarte einblenden" }).click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toBeVisible();

    await page.getByRole("button", { name: "Zur Warnkarte zoomen" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 720, y: 450 },
    });
    const probabilityTooltip = page.locator(".priwa-warnkarte-tooltip");
    await expect(probabilityTooltip).toContainText("Wahrscheinlichkeit: 60 %");

    await expect(warnkarteControl).toBeVisible();
    await expect(warnkarteControl).toHaveClass(/ant-btn-circle/);
    await expect(page.getByTestId("priwa-review-detail-panel")).toContainText(
      "Befallsgruppe Test",
    );
    await page
      .getByTestId("priwa-review-detail-panel")
      .getByRole("button", { name: "Baum bearbeiten" })
      .click();
    await expect(page.locator("#priwa-review-tree-panel")).toBeVisible();
    await warnkarteControl.click();
    await expect(page.getByTestId("priwa-warnkarte-admin-panel")).toBeVisible();
    await expect(page.locator("#priwa-review-tree-panel")).toHaveCount(0);
    await expect(page.getByText("Aktiv", { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("radio", { name: "Auf Karte sichtbar" }),
    ).toBeChecked();
    await page.getByRole("radio", { name: "Auf Karte anzeigen" }).click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 01.07.2024",
    );
    await expect(
      page.getByRole("radio", { name: "Auf Karte sichtbar" }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Zu Karte wechseln" }).click();
    await expect(
      page.getByRole("button", { name: "Zu Luftbild wechseln" }),
    ).toBeVisible();
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
        name: "Unveröffentlicht importieren und anzeigen",
      })
      .click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 01.07.2024",
    );
    await expect(probabilityTooltip).toBeHidden();

    const newVersion = page.getByText("Warnkarte vom 01.07.2024").last();
    const versionRow = newVersion.locator("xpath=ancestor::li");
    await versionRow.getByRole("button", { name: "Veröffentlichen" }).click();
    await page
      .getByRole("button", { name: "Veröffentlichen", exact: true })
      .last()
      .click();
    await expect(page.getByText("Warnkarte veröffentlicht.")).toBeVisible();
    await expect(page.getByText(/Vorschau ·/)).toHaveCount(0);
    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 01.07.2024",
    );
    await expect(page.getByText("Aktiv", { exact: true })).toHaveCount(1);
    await page
      .getByTestId("priwa-warnkarte-admin-panel")
      .getByRole("button", { name: "Warnkarten-Verwaltung schließen" })
      .click();
    await expect(page.getByTestId("priwa-warnkarte-admin-panel")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("priwa-review-detail-panel")).toBeVisible();
    await expect(page.getByTestId("priwa-review-detail-panel")).toContainText(
      "Befallsgruppe Test",
    );
  });

  test("closing management discards a pending version selection", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page, { overlayDelayMs: 500 });
    await page.goto("/priwa-field");

    await page.getByRole("button", { name: "Warnkarte verwalten" }).click();
    const overlayResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/versions/version-new/overlay") &&
        response.status() === 200,
    );
    await page.getByRole("radio", { name: "Auf Karte anzeigen" }).click();
    await page
      .getByTestId("priwa-warnkarte-admin-panel")
      .getByRole("button", { name: "Warnkarten-Verwaltung schließen" })
      .click();
    await overlayResponse;

    await expect(page.getByTestId("priwa-warnkarte-admin-panel")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 25.06.2024",
    );
  });

  test("desktop admin archives and restores an inactive Warnkarte", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    await page.getByRole("button", { name: "Warnkarte verwalten" }).click();
    await expect(
      page
        .getByTestId("priwa-warnkarte-version-version-old")
        .getByRole("button", { name: "Archivieren" }),
    ).toHaveCount(0);
    const version = page.getByTestId("priwa-warnkarte-version-version-new");
    await version.getByRole("radio", { name: "Auf Karte anzeigen" }).click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 01.07.2024",
    );

    await version.getByRole("button", { name: "Archivieren" }).click();
    await page
      .getByRole("button", { name: "Archivieren", exact: true })
      .last()
      .click();

    await expect(page.getByText("Warnkartenversion archiviert.")).toBeVisible();
    await expect(
      page.getByTestId("priwa-warnkarte-version-version-new"),
    ).toHaveCount(0);
    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 25.06.2024",
    );
    await page.getByText("Archiviert (1)").click();

    const archivedVersion = page.getByTestId(
      "priwa-warnkarte-archived-version-new",
    );
    await archivedVersion
      .getByRole("button", { name: "Wiederherstellen" })
      .click();

    await expect(
      page.getByText("Warnkartenversion wiederhergestellt."),
    ).toBeVisible();
    await expect(
      page.getByTestId("priwa-warnkarte-version-version-new"),
    ).toBeVisible();
    await expect(page.getByText("Archiviert (1)")).toHaveCount(0);
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

  test("desktop environment explains when Warnkarte API routes are not deployed", async ({
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
      "Die Warnkarten-Funktion ist in dieser Umgebung noch nicht verfügbar. Die Datei wurde nicht validiert.";
    await expect(page.getByText(explanation)).toHaveCount(1);

    await page.locator('input[type="file"]').setInputFiles({
      name: "warnkarte_2024-07-01.gpkg",
      mimeType: "application/geopackage+sqlite3",
      buffer: Buffer.from("mocked direct geopackage"),
    });

    await expect(page.getByText(explanation)).toHaveCount(2);
    await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0);
  });

  test("mobile can navigate to an off-screen published overlay", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 25.06.2024",
    );
    await expect(
      page.getByRole("button", { name: "Warnkarte verwalten" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Zur Warnkarte zoomen" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 196, y: 426 },
    });
    await expect(page.locator(".priwa-warnkarte-tooltip")).toContainText(
      "Wahrscheinlichkeit: 60 %",
    );
    await page.getByRole("button", { name: "Warnkarte ausblenden" }).click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Zur Warnkarte zoomen" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Warnkarte einblenden" }),
    ).toBeVisible();
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();
  });
});
