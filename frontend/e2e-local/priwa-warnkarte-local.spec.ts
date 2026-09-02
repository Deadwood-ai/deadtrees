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
  const session = await installLocalSession(page, {
    user: admin,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "priwa-warnkarte-refresh-token",
  });

  // Keep the mocked journey independent from the worktree's generated
  // Supabase endpoint. The application and test runner can legitimately read
  // that endpoint from different env files.
  await page.route("**/auth/v1/user", (route) =>
    route.fulfill({ contentType: "application/json", json: session.user }),
  );
  await page.route("**/rest/v1/**", fulfillSupabaseRequest);
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
  test("tablet portrait keeps the mobile map surface usable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    await expect(page.locator("[data-priwa-review-queue-panel]")).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Warnkarte verwalten" }),
    ).toHaveCount(0);
    await expect(page.locator(".dt-map-zoom-control")).toBeHidden();
    await expect(page.locator(".dt-map-scale-control")).toBeVisible();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 384, y: 450 },
    });
    await expect(page.getByText("Käferbaum bearbeiten")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Kartenebenen öffnen" }).click();
    await page.getByRole("button", { name: "Zur Warnkarte zoomen" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 384, y: 450 },
    });
    await expect(page.locator(".priwa-warnkarte-tooltip")).toContainText(
      "Wahrscheinlichkeit: 60 %",
    );
  });

  test("desktop boundary fits an off-screen overlay between review panels", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 992, height: 768 });
    await installWarnkarteAdmin(page);
    await installWarnkarteApi(page);
    await page.goto("/priwa-field");

    const zoomControl = page.locator(".dt-map-zoom-control");
    const scaleLine = page.locator(".dt-map-scale-control-inner");
    await expect(zoomControl).toBeVisible();
    await expect(zoomControl.getByTitle("Zoom in")).toBeVisible();
    await expect(zoomControl.getByTitle("Zoom out")).toBeVisible();
    await expect(scaleLine).not.toBeEmpty();
    const scaleBeforeZoom = await scaleLine.innerText();
    await zoomControl.getByTitle("Zoom in").click();
    await expect.poll(() => scaleLine.innerText()).not.toBe(scaleBeforeZoom);

    await page.getByRole("button", { name: "Zur Warnkarte zoomen" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 480, y: 384 },
    });
    await expect(page.locator(".priwa-warnkarte-tooltip")).toContainText(
      "Wahrscheinlichkeit: 60 %",
    );
  });

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
    await page
      .getByTestId("priwa-tree-inspector")
      .getByRole("button", { name: "Baum auf Karte zeigen" })
      .click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 524, y: 450 },
    });
    await expect(probabilityTooltip).toBeHidden();
    await page.getByRole("button", { name: "Zur Warnkarte zoomen" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 524, y: 450 },
    });
    await expect(probabilityTooltip).toContainText("Wahrscheinlichkeit: 60 %");
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
    await page.route("**/priwa/warnkarte/active?*", unavailable);
    await page.goto("/priwa-field");

    const loadError = page.getByText("Warnkarte konnte nicht geladen werden", {
      exact: true,
    });
    await expect(loadError).toHaveCount(0);
    await page.getByRole("button", { name: "Warnkarte einblenden" }).click();
    await expect(loadError).toBeVisible();
    await expect(loadError).toBeHidden({ timeout: 5_000 });

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
    await page.getByRole("button", { name: "Accept" }).click();

    await expect(page.getByTestId("priwa-warnkarte-legend")).toContainText(
      "Warnkarte 25.06.2024",
    );
    await expect(
      page.getByRole("button", { name: "Warnkarte verwalten" }),
    ).toHaveCount(0);
    await expect(page.locator(".dt-map-zoom-control")).toBeHidden();
    await expect(page.locator(".dt-map-scale-control")).toBeVisible();
    await page.getByRole("button", { name: "Kartenebenen öffnen" }).click();
    await page.getByRole("button", { name: "Baumliste öffnen" }).click();
    await expect(page.getByLabel("Kartenebenen", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("Käferbäume (1)", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Kartenebenen öffnen" }).click();
    const layerSheet = page.getByLabel("Kartenebenen", { exact: true });
    const layerSheetBox = await layerSheet.boundingBox();
    expect(layerSheetBox).not.toBeNull();
    expect(layerSheetBox!.height / 852).toBeGreaterThan(0.22);
    expect(layerSheetBox!.height / 852).toBeLessThan(0.36);
    const layerSheetHeaderBox = await layerSheet
      .locator("header")
      .boundingBox();
    expect(layerSheetHeaderBox).not.toBeNull();
    await page.mouse.move(
      layerSheetHeaderBox!.x + layerSheetHeaderBox!.width / 2,
      layerSheetHeaderBox!.y + 12,
    );
    await page.mouse.down();
    await page.mouse.move(
      layerSheetHeaderBox!.x + layerSheetHeaderBox!.width / 2,
      layerSheetHeaderBox!.y - 280,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect(layerSheet).toHaveAttribute(
      "data-mobile-bottom-sheet-snap",
      "expanded",
    );
    await page.getByRole("button", { name: "Zur Warnkarte zoomen" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("priwa-field-map").click({
      position: { x: 196, y: 426 },
    });
    await expect(page.locator(".priwa-warnkarte-tooltip")).toContainText(
      "Wahrscheinlichkeit: 60 %",
    );
    await page.getByRole("button", { name: "Kartenebenen öffnen" }).click();
    await page.getByRole("switch", { name: "Warnkarte ausblenden" }).click();
    await expect(page.getByTestId("priwa-warnkarte-legend")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Zur Warnkarte zoomen" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("switch", { name: "Warnkarte einblenden" }),
    ).toBeVisible();
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();
    await page.getByRole("button", { name: "Kartenebenen schließen" }).click();
    await page.getByRole("button", { name: /Offline-Karten öffnen/ }).click();
    await expect(
      page.getByLabel("Offline-Karten", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Neuen Bereich auswählen" }).click();
    const selectionFrame = page.locator(
      '[data-priwa-offline-selection-frame="true"]',
    );
    const selectionSheet = page.getByLabel("Offline-Bereich auswählen", {
      exact: true,
    });
    const [selectionFrameBox, selectionSheetBox] = await Promise.all([
      selectionFrame.boundingBox(),
      selectionSheet.boundingBox(),
    ]);
    expect(selectionFrameBox).not.toBeNull();
    expect(selectionSheetBox).not.toBeNull();
    expect(
      Math.abs(selectionFrameBox!.width - selectionFrameBox!.height),
    ).toBeLessThan(2);
    expect(selectionFrameBox!.y + selectionFrameBox!.height).toBeLessThan(
      selectionSheetBox!.y,
    );
    const [selectionTitleBox, selectionCloseBox] = await Promise.all([
      page
        .getByRole("heading", { name: "Offline-Bereich auswählen" })
        .boundingBox(),
      page
        .getByRole("button", { name: "Bereichsauswahl schließen" })
        .boundingBox(),
    ]);
    expect(selectionTitleBox).not.toBeNull();
    expect(selectionCloseBox).not.toBeNull();
    expect(selectionTitleBox!.x).toBeGreaterThanOrEqual(12);
    expect(selectionCloseBox!.x + selectionCloseBox!.width).toBeLessThanOrEqual(
      381,
    );
  });

  test("mobile only reports an unavailable Warnkarte after activation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await installWarnkarteAdmin(page);
    await page.route("**/priwa/warnkarte/active?*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { detail: "Offline" },
      }),
    );
    await page.goto("/priwa-field");
    await page.getByRole("button", { name: "Accept" }).click();

    const errorMessage = page.getByText(
      "Warnkarte konnte nicht geladen werden",
      { exact: true },
    );
    await expect(errorMessage).toHaveCount(0);
    await page.getByRole("button", { name: "Kartenebenen öffnen" }).click();
    await page.getByRole("switch", { name: "Warnkarte einblenden" }).click();
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toBeHidden({ timeout: 5_000 });
  });
});
