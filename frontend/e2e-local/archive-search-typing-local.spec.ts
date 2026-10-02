import { expect, test, type Page, type Route } from "@playwright/test";

import { acceptCookieConsent } from "./support/localAuth";

// Regression for lost keystrokes in the archive "Author or place" field. The
// archive is mocked at production scale (~7.5k datasets) so every keystroke pays
// the real filtering, list and map cost. No seeded DB is needed.

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";

const ARCHIVE_SIZE = 7500;
const AUTHORS = [
  "José García",
  "Anna Müller",
  "Zoë Brontë",
  "Søren Ångström",
  "Li Wei",
  "Émile Durand",
  "Ola Nordmann",
  "María Fernández",
];
const PLACES: Array<[string, string, string]> = [
  ["DEU", "Baden-Württemberg", "Freiburg im Breisgau"],
  ["ESP", "Andalucía", "Córdoba"],
  ["FRA", "Auvergne-Rhône-Alpes", "Isère"],
  ["SWE", "Västra Götaland", "Göteborg"],
  ["USA", "California", "Sierra County"],
  ["BRA", "Pará", "Santarém"],
];

const archiveItems = Array.from({ length: ARCHIVE_SIZE }, (_, index) => {
  const [country, region, district] = PLACES[index % PLACES.length];
  // Deterministic spread over the globe so the map draws every footprint.
  const lon = ((index * 37) % 340) - 170;
  const lat = ((index * 17) % 140) - 70;
  return {
    id: index + 1,
    created_at: "2026-02-02T03:04:05Z",
    license: "CC BY",
    platform: "drone",
    authors: [
      AUTHORS[index % AUTHORS.length],
      `${AUTHORS[(index * 7 + 3) % AUTHORS.length]} ${index % 97}`,
    ],
    aquisition_year: String(2015 + (index % 10)),
    aquisition_month: "5",
    aquisition_day: "6",
    data_access: "public",
    bbox: `BOX(${lon} ${lat},${lon + 0.01} ${lat + 0.01})`,
    thumbnail_path: null,
    admin_level_1: country,
    admin_level_2: region,
    admin_level_3: `${district} ${index % 50}`,
    biome_name: "Temperate Broadleaf and Mixed Forests",
    has_labels: index % 3 === 0,
    has_deadwood_prediction: true,
  };
});

const fulfillJson = (route: Route, json: unknown) =>
  route.fulfill({
    contentType: "application/json",
    headers: { "content-range": "0-0/1" },
    json,
  });

interface TypingMetrics {
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  keyEventMaxMs: number;
}

const openArchive = async (page: Page, path = "/dataset") => {
  await acceptCookieConsent(page);
  await page.addInitScript(() => {
    window.sessionStorage.setItem("deadtrees-preview-warning-shown", "true");
    const metrics = {
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longTaskMaxMs: 0,
      keyEventMaxMs: 0,
    };
    Object.assign(window, { __typingMetrics: metrics });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        metrics.longTaskCount += 1;
        metrics.longTaskTotalMs += entry.duration;
        metrics.longTaskMaxMs = Math.max(metrics.longTaskMaxMs, entry.duration);
      }
    }).observe({ type: "longtask" });
    // Event Timing: time from the key event until the next paint.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!/^(keydown|keypress|input|keyup)$/.test(entry.name)) continue;
        metrics.keyEventMaxMs = Math.max(metrics.keyEventMaxMs, entry.duration);
      }
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
  });
  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const resource = new URL(route.request().url()).pathname.split("/").at(-1);
    await fulfillJson(
      route,
      resource === "public_dataset_archive_items" ? archiveItems : [],
    );
  });
  await page.goto(path);
  await expect(page.getByTestId("dataset-list-item").first()).toBeVisible();
  // Let the map finish its first draw so it does not count as typing cost.
  await page.waitForTimeout(1500);
};

const resetMetrics = (page: Page) =>
  page.evaluate(() => {
    const metrics = (window as unknown as { __typingMetrics: TypingMetrics })
      .__typingMetrics;
    metrics.longTaskCount = 0;
    metrics.longTaskTotalMs = 0;
    metrics.longTaskMaxMs = 0;
    metrics.keyEventMaxMs = 0;
  });

const readMetrics = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __typingMetrics: TypingMetrics }).__typingMetrics,
  );

const QUERY = "Freiburg im Breisgau";

for (const delay of [0, 30]) {
  test(`archive text search keeps every keystroke typed with ${delay}ms between keys`, async ({
    page,
  }, testInfo) => {
    await openArchive(page);
    const search = page.getByTestId("dataset-search-input");
    await search.click();
    await resetMetrics(page);

    const startedAt = Date.now();
    await search.pressSequentially(QUERY, { delay });
    const typingMs = Date.now() - startedAt;
    const valueAfterTyping = await search.inputValue();
    // Let pending work settle so the long-task totals cover the whole burst.
    await page.waitForTimeout(1000);
    const metrics = { typingMs, valueAfterTyping, ...(await readMetrics(page)) };
    console.log(`[archive-search-typing delay=${delay}] ${JSON.stringify(metrics)}`);
    await testInfo.attach("typing-metrics", {
      body: JSON.stringify(metrics, null, 2),
      contentType: "application/json",
    });

    expect(valueAfterTyping).toBe(QUERY);
    await expect(search).toHaveValue(QUERY);
    await expect(page).toHaveURL(/[?&]text=Freiburg\+im\+Breisgau/);
    await expect(
      page.getByRole("link", { name: /Open dataset Freiburg im Breisgau/ }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Open dataset Córdoba/ }),
    ).toHaveCount(0);
  });
}

test("archive text search follows shared links, history and clearing", async ({
  page,
}) => {
  await openArchive(page, "/dataset?text=cordoba");
  const search = page.getByTestId("dataset-search-input");
  await expect(search).toHaveValue("cordoba");
  await expect(
    page.getByRole("link", { name: /Open dataset Córdoba/ }).first(),
  ).toBeVisible();

  // A navigation that leaves the page and comes back restores the query.
  await page.getByRole("link", { name: /Open dataset Córdoba/ }).first().click();
  await expect(page).toHaveURL(/\/dataset\/\d+/);
  await page.goBack();
  await expect(search).toHaveValue("cordoba");

  await page.getByLabel("Clear search").click();
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/text=/);
  await expect(
    page.getByRole("link", { name: /Open dataset Freiburg/ }).first(),
  ).toBeVisible();

  // Switching mode clears the text query, as before.
  await search.pressSequentially("isere", { delay: 0 });
  await expect(page).toHaveURL(/text=isere/);
  await page.getByRole("button", { name: "Search mode" }).click();
  await page.getByRole("menuitem", { name: "AI search" }).click();
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(/search=ai/);
  await expect(page).not.toHaveURL(/text=/);
});
