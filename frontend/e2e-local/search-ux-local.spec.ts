import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

// Exercises the open-vocabulary search UX changes on the dataset archive and
// dataset details pages, driven entirely through mocked Supabase/API responses
// (no seeded DB). Covers:
//   1. semantic search results persist across navigate-away + browser back
//   2. result rows are real links -> middle-click opens a new tab
//   3. the per-orthophoto AI search disables itself when embeddings are missing
//   4. successful auditor searches use embed -> RPC -> analytics ordering

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rgbGeoTiffFixture = path.resolve(
  __dirname,
  "../test/fixtures/geotiff/upload-validation/rgb-real-crop.tif",
);

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";

const auditor = {
  id: "00000000-0000-4000-8000-0000000000c3",
  email: "search-ux-e2e@example.com",
};

// Two datasets. 5001 has embeddings (search enabled); 5002 does not (disabled).
const datasetWithEmbeddings = 5001;
const datasetWithoutEmbeddings = 5002;

const archiveItem = (id: number, region: string) => ({
  id,
  created_at: "2026-02-02T03:04:05Z",
  license: "CC BY",
  platform: "drone",
  authors: [`Author ${id}`],
  aquisition_year: "2024",
  aquisition_month: "5",
  aquisition_day: "6",
  data_access: "public",
  bbox: null,
  thumbnail_path: null,
  admin_level_1: "DEU",
  admin_level_2: region,
  admin_level_3: region,
  biome_name: "Temperate Broadleaf & Mixed Forests",
  has_labels: true,
  has_deadwood_prediction: true,
  is_audited: true,
});

const archiveItems = [
  archiveItem(datasetWithEmbeddings, "Alphaville"),
  archiveItem(datasetWithoutEmbeddings, "Betatown"),
];

const fullDataset = (id: number, region: string) => ({
  ...archiveItem(id, region),
  file_name: `dataset-${id}.tif`,
  additional_information: null,
  citation_doi: null,
  archived: false,
  ortho_file_name: `dataset-${id}.tif`,
  ortho_file_size: 12345,
  sha256: `sha-${id}`,
  current_status: "idle",
  is_upload_done: true,
  is_odm_done: true,
  is_ortho_done: true,
  is_cog_done: true,
  is_thumbnail_done: true,
  is_deadwood_done: true,
  is_forest_cover_done: true,
  is_combined_model_done: true,
  is_aoi_done: false,
  is_aoi_required: false,
  is_metadata_done: true,
  has_error: false,
  error_message: null,
  cog_file_name: `dataset-${id}_cog.tif`,
  cog_path: `/cog/dataset-${id}.tif`,
  cog_file_size: 23456,
  thumbnail_file_name: null,
  has_ml_tiles: false,
});

let embedRequests: Array<Record<string, unknown>> = [];
let rpcRequests: Array<{
  name: string;
  body: Record<string, unknown>;
}> = [];
let loggedQueries: Array<Record<string, unknown>> = [];
let searchEvents: string[] = [];
let failDatasetRanking = false;

const fulfillJson = async (route: Route, json: unknown) => {
  await route.fulfill({
    contentType: "application/json",
    headers: { "content-range": "0-0/1" },
    json,
  });
};

const fulfillRpc = async (route: Route, rpcName: string | undefined) => {
  const body = route.request().postDataJSON() as Record<string, unknown>;
  rpcRequests.push({ name: rpcName ?? "unknown", body });

  if (rpcName === "search_datasets_by_embedding") {
    searchEvents.push("dataset-rpc");
    if (failDatasetRanking) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        json: {
          code: "42501",
          message: "AI search is restricted to auditors",
        },
      });
      return;
    }
    await fulfillJson(route, [
      { dataset_id: datasetWithEmbeddings, similarity: 0.92, tile_count: 3 },
      { dataset_id: datasetWithoutEmbeddings, similarity: 0.41, tile_count: 1 },
    ]);
    return;
  }
  if (rpcName === "search_tiles_by_embedding") {
    searchEvents.push("tile-rpc");
  }
  await fulfillJson(route, []);
};

const fulfillSupabaseRequest = async (
  route: Route,
  canAudit: boolean,
  embeddingsStatusError: boolean,
) => {
  const request = route.request();
  const url = new URL(request.url());
  const segments = url.pathname.split("/").filter(Boolean);
  const resource = segments.at(-1);
  const method = request.method();
  const wantsObject =
    request.headers()["accept"]?.includes("vnd.pgrst.object") ?? false;

  if (segments.at(-2) === "rpc") {
    await fulfillRpc(route, resource);
    return;
  }

  if (resource === "privileged_users") {
    await fulfillJson(route, {
      id: 1,
      user_id: auditor.id,
      can_upload_private: false,
      can_audit: canAudit,
      can_view_all_private: false,
      created_at: "2026-01-01T00:00:00Z",
    });
    return;
  }

  if (resource === "public_dataset_archive_items") {
    await fulfillJson(route, archiveItems);
    return;
  }

  if (
    resource === "v2_full_dataset_view_public" ||
    resource === "v2_full_dataset_view"
  ) {
    const idFilter = url.searchParams.get("id");
    const id = idFilter?.startsWith("eq.") ? Number(idFilter.slice(3)) : null;
    const row = id
      ? fullDataset(
          id,
          id === datasetWithEmbeddings ? "Alphaville" : "Betatown",
        )
      : null;
    await fulfillJson(route, wantsObject ? row : row ? [row] : []);
    return;
  }

  if (resource === "v2_statuses") {
    if (embeddingsStatusError) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { message: "unavailable" },
      });
      return;
    }
    // The embeddings-availability hook reads one status row per dataset.
    const idFilter = url.searchParams.get("dataset_id");
    const id = idFilter?.startsWith("eq.") ? Number(idFilter.slice(3)) : null;
    const isDone = id === datasetWithEmbeddings;
    await fulfillJson(
      route,
      wantsObject
        ? { is_embeddings_done: isDone }
        : [{ is_embeddings_done: isDone }],
    );
    return;
  }

  if (resource === "v2_search_queries") {
    if (method === "POST") {
      const payload = request.postDataJSON();
      const rows = Array.isArray(payload) ? payload : [payload];
      loggedQueries.push(...(rows as Array<Record<string, unknown>>));
      searchEvents.push("log");
      await fulfillJson(route, rows);
      return;
    }
    await fulfillJson(route, []);
    return;
  }

  // AOIs, labels, metadata, etc. — empty is fine for these flows.
  await fulfillJson(route, wantsObject ? null : []);
};

const installAuditor = async (
  page: Page,
  canAudit = true,
  embeddingsStatusError = false,
) => {
  await installLocalSession(page, {
    user: auditor,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "search-ux-e2e-refresh",
    acceptCookies: true,
  });

  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    await fulfillSupabaseRequest(route, canAudit, embeddingsStatusError);
  });

  await page.route("**/search/embed", async (route) => {
    embedRequests.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    searchEvents.push("embed");
    await fulfillJson(route, { embedding: "[1,0,0]" });
  });

  // Serve the fixture GeoTIFF for the details-page COG so the map can init.
  await page.route("**/cogs/v1/**", async (route) => {
    const buffer = fs.readFileSync(rgbGeoTiffFixture);
    await route.fulfill({
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(buffer.length),
        "content-type": "image/tiff",
      },
      body: buffer,
    });
  });
};

const runSemanticSearch = async (page: Page, query: string) => {
  const input = page.getByPlaceholder(/AI search/);
  await input.fill(query);
  await input.press("Enter");
  await expect(page.getByText(/Ranked by/)).toBeVisible();
};

test.describe("search UX (local)", () => {
  test.beforeEach(() => {
    embedRequests = [];
    rpcRequests = [];
    loggedQueries = [];
    searchEvents = [];
    failDatasetRanking = false;
  });

  test("semantic results persist after visiting a dataset and pressing back", async ({
    page,
  }) => {
    await installAuditor(page);
    await page.goto("/dataset");

    await runSemanticSearch(page, "forest");
    await expect(page).toHaveURL(/\/dataset\?q=forest$/);
    const items = page.getByTestId("dataset-list-item");
    await expect(items.first()).toBeVisible();
    await expect(
      page.getByTestId("dataset-semantic-score").first(),
    ).toBeVisible();
    const countBefore = await items.count();

    // Navigate into the top result, then use the browser back button.
    await items.first().click();
    await page.waitForURL(
      new RegExp(`/dataset/${datasetWithEmbeddings}(\\?.*)?$`),
    );
    await page.goBack();
    await page.waitForURL(/\/dataset(\?.*)?$/);

    // The active query, its "Ranked by" chip and the ranked results survive.
    await expect(page.getByText(/Ranked by/)).toBeVisible();
    await expect(
      page.getByTestId("dataset-semantic-score").first(),
    ).toBeVisible();
    expect(await page.getByTestId("dataset-list-item").count()).toBe(
      countBefore,
    );
  });

  test("a successful search embeds, ranks, then records analytics", async ({
    page,
  }) => {
    await installAuditor(page);
    await page.goto("/dataset");

    await runSemanticSearch(page, "clearcut");

    await expect.poll(() => loggedQueries.length).toBe(1);
    expect(embedRequests).toEqual([{ query: "clearcut" }]);
    expect(rpcRequests).toHaveLength(1);
    expect(rpcRequests[0]).toMatchObject({
      name: "search_datasets_by_embedding",
      body: { query_embedding: "[1,0,0]" },
    });
    expect(loggedQueries[0]).toMatchObject({
      query: "clearcut",
      dataset_id: null,
    });
    expect(searchEvents.slice(0, 3)).toEqual([
      "embed",
      "dataset-rpc",
      "log",
    ]);

    await page.getByPlaceholder(/AI search/).press("Enter");
    await expect.poll(() => loggedQueries.length).toBe(2);
    expect(embedRequests).toHaveLength(2);
    expect(rpcRequests).toHaveLength(2);
  });

  test("a failed ranking RPC is not recorded as a successful search", async ({
    page,
  }) => {
    await installAuditor(page);
    failDatasetRanking = true;
    await page.goto("/dataset");

    const input = page.getByPlaceholder(/AI search/);
    await input.fill("forest");
    await input.press("Enter");

    await expect(
      page.getByText("AI search is restricted to auditors"),
    ).toBeVisible();
    expect(embedRequests).toEqual([{ query: "forest" }]);
    expect(loggedQueries).toHaveLength(0);
  });

  test("clearing an in-flight search cannot restore stale results", async ({
    page,
  }) => {
    await installAuditor(page);

    let started = false;
    let releaseSearch!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    await page.route(
      `${localSupabaseUrl}/rest/v1/rpc/search_datasets_by_embedding`,
      async (route) => {
        started = true;
        await pending;
        await fulfillJson(route, [
          { dataset_id: datasetWithEmbeddings, similarity: 0.92, tile_count: 3 },
        ]);
      },
    );

    await page.goto("/dataset");
    await page
      .getByRole("checkbox", { name: "Filter list by map view" })
      .uncheck();
    const input = page.getByPlaceholder(/AI search/);
    await input.fill("forest");
    await input.press("Enter");
    await expect.poll(() => started).toBe(true);
    await expect(page).toHaveURL(/\?q=forest$/);

    await input.fill("");
    await expect(page).toHaveURL(/\/dataset$/);
    releaseSearch();

    await expect(page.getByText(/Ranked by/)).toHaveCount(0);
    await expect(page.getByTestId("dataset-list-item")).toHaveCount(
      archiveItems.length,
    );
  });

  test("permission loss cannot leave the archive invisibly filtered", async ({
    page,
  }) => {
    await installAuditor(page, false);
    await page.goto("/dataset?q=forest");

    await expect(page.getByTestId("dataset-semantic-search-input")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("dataset-list-item")).toHaveCount(
      archiveItems.length,
    );
    expect(embedRequests).toHaveLength(0);
    expect(rpcRequests).toHaveLength(0);
    expect(loggedQueries).toHaveLength(0);
  });

  test("result rows open in a new tab on middle-click", async ({
    page,
    context,
  }) => {
    await installAuditor(page);
    await page.goto("/dataset");
    await runSemanticSearch(page, "water");

    const firstRow = page.getByTestId("dataset-list-item").first();
    // Real <a href> -> middle-click is a native "open in new tab".
    const popupPromise = context.waitForEvent("page");
    await firstRow.click({ button: "middle" });
    const popup = await popupPromise;
    // The tab opens at about:blank then navigates to the anchor href.
    await popup.waitForURL(
      new RegExp(`/dataset/${datasetWithEmbeddings}(\\?.*)?$`),
    );
    expect(popup.url()).toContain(`/dataset/${datasetWithEmbeddings}`);
    await popup.close();
  });

  test("per-orthophoto AI search is disabled when embeddings are missing", async ({
    page,
  }) => {
    await installAuditor(page);

    // Dataset 5002 has is_embeddings_done = false.
    await page.goto(`/dataset/${datasetWithoutEmbeddings}`);

    await expect(
      page.getByTestId("ortho-tile-search-unavailable"),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/not available/)).toBeDisabled();
  });

  test("per-orthophoto AI search is enabled when embeddings exist", async ({
    page,
  }) => {
    await installAuditor(page);

    // Dataset 5001 has is_embeddings_done = true.
    await page.goto(`/dataset/${datasetWithEmbeddings}`);

    await expect(page.getByPlaceholder(/Search this orthophoto/)).toBeEnabled();
    await expect(page.getByTestId("ortho-tile-search-unavailable")).toHaveCount(
      0,
    );
  });

  test("embedding readiness failures are explicit and keep search disabled", async ({
    page,
  }) => {
    await installAuditor(page, true, true);
    await page.goto(`/dataset/${datasetWithEmbeddings}`);

    await expect(
      page.getByTestId("ortho-tile-search-availability-error"),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/status unavailable/)).toBeDisabled();
  });
});
