import { expect, test, type Page, type Route } from "@playwright/test";

import { installLocalSession } from "./support/localAuth";

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";

const coreTeamUser = {
  id: "00000000-0000-4000-8000-0000000000d1",
  email: "core-team-map-local@example.com",
};
const contributor = {
  id: "00000000-0000-4000-8000-0000000000d2",
  email: "contributor-map-local@example.com",
};

const archiveItems = [
  {
    id: 6101,
    created_at: "2026-02-02T03:04:05Z",
    license: "CC BY",
    platform: "drone",
    authors: ["Primary Author", "José García"],
    aquisition_year: "2024",
    aquisition_month: "5",
    aquisition_day: "6",
    data_access: "public",
    bbox: null,
    thumbnail_path: null,
    admin_level_1: "ESP",
    admin_level_2: "Andalucía",
    admin_level_3: "Córdoba",
    biome_name: "Mediterranean Forests, Woodlands, and Scrub",
    has_labels: true,
    has_deadwood_prediction: true,
  },
  {
    id: 6102,
    created_at: "2026-02-03T03:04:05Z",
    license: "CC BY",
    platform: "drone",
    authors: ["Different Author"],
    aquisition_year: "2024",
    aquisition_month: "5",
    aquisition_day: "7",
    data_access: "public",
    bbox: null,
    thumbnail_path: null,
    admin_level_1: "DEU",
    admin_level_2: "Baden-Württemberg",
    admin_level_3: "Freiburg",
    biome_name: "Temperate Broadleaf and Mixed Forests",
    has_labels: false,
    has_deadwood_prediction: true,
  },
];

const observation = {
  id: "observation-core-team",
  geom: { type: "Point", coordinates: [8.68, 50.11] },
  condition: "dead",
  tree_type_group: "conifer",
  tree_type_text: "Spruce",
  comment: "Core-team fixture",
  created_at: "2026-06-10T10:00:00.000Z",
};

const fulfillJson = async (route: Route, json: unknown) => {
  await route.fulfill({
    contentType: "application/json",
    headers: { "content-range": "0-0/1" },
    json,
  });
};

const installStableUiState = async (page: Page) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("cookieConsent", "accepted");
    window.localStorage.setItem("cookieConsentVersion", "1.1");
    window.sessionStorage.setItem("deadtrees-preview-warning-shown", "true");
  });
};

const installSupabaseMocks = async (
  page: Page,
  options: { canAudit?: boolean; userId?: string } = {},
) => {
  let observationRequests = 0;

  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const resource = url.pathname.split("/").filter(Boolean).at(-1);

    if (resource === "public_dataset_archive_items") {
      await fulfillJson(route, archiveItems);
      return;
    }

    if (resource === "privileged_users") {
      await fulfillJson(route, {
        id: 1,
        user_id: options.userId,
        can_upload_private: false,
        can_audit: options.canAudit === true,
        can_view_all_private: false,
        created_at: "2026-01-01T00:00:00Z",
      });
      return;
    }

    if (resource === "public_tree_observations") {
      observationRequests += 1;
      await fulfillJson(route, [observation]);
      return;
    }

    await fulfillJson(route, []);
  });

  return () => observationRequests;
};

test("archive search and author suggestions match every author without accents", async ({
  page,
}) => {
  await installStableUiState(page);
  await installSupabaseMocks(page);
  await page.goto("/dataset");

  const search = page.getByTestId("dataset-search-input");
  await search.fill("garcia");
  await expect(page.getByTestId("dataset-list-item")).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Open dataset Córdoba" }),
  ).toBeVisible();

  await search.fill("JOSE\u0301 GARCI\u0301A");
  await expect(page.getByTestId("dataset-list-item")).toHaveCount(1);

  await search.clear();
  await page.getByRole("button", { name: "Advanced filters" }).click();
  const dialog = page.getByRole("dialog", { name: "Advanced Filters" });
  const authorSelect = dialog
    .locator(".ant-form-item")
    .filter({ hasText: "Authors" })
    .getByRole("combobox");
  await authorSelect.click();
  await authorSelect.fill("garcia");
  await expect(
    page
      .locator(".ant-select-dropdown:visible")
      .locator(".ant-select-item-option-content")
      .filter({ hasText: /^José García$/ }),
  ).toBeVisible();
});

test("anonymous satellite-map visitors cannot access point observations", async ({
  page,
}) => {
  await installStableUiState(page);
  const getObservationRequests = await installSupabaseMocks(page);
  await page.goto("/deadtrees");

  await expect(page.getByTestId("deadtrees-layer-controls")).toBeVisible();
  await expect(page.getByText("Point observations", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Add point observations from the mobile map.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add dead tree observation" })).toHaveCount(0);
  expect(getObservationRequests()).toBe(0);
});

test("authenticated non-core contributors cannot access point observations", async ({
  page,
}) => {
  await installLocalSession(page, {
    user: contributor,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "contributor-map-local-refresh",
  });
  await installStableUiState(page);
  const getObservationRequests = await installSupabaseMocks(page, {
    canAudit: false,
    userId: contributor.id,
  });
  await page.goto("/deadtrees");

  await expect(page.getByTestId("deadtrees-layer-controls")).toBeVisible();
  await expect(page.getByText("Point observations", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Add point observations from the mobile map.")).toHaveCount(0);
  expect(getObservationRequests()).toBe(0);
});

test("resolved core-team members keep the point-observation workflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installLocalSession(page, {
    user: coreTeamUser,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "core-team-map-local-refresh",
  });
  await installStableUiState(page);
  const getObservationRequests = await installSupabaseMocks(page, {
    canAudit: true,
    userId: coreTeamUser.id,
  });
  await page.goto("/deadtrees");

  await expect(
    page.getByRole("button", { name: "Add dead tree observation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open map layers" }).click();
  await expect(page.getByText("Point observations", { exact: true })).toBeVisible();
  await expect.poll(getObservationRequests).toBeGreaterThan(0);
});
