import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

// Benchmark labeling on the audit page (docs/playbooks/audit-and-benchmarks.md), against mocked
// Supabase and API responses: nothing is written anywhere. A benchmark is the set of people's
// reviews ticked in_benchmark; a label is a review insert with the tick.

const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const auditor = { id: "00000000-0000-4000-8000-0000000000c1", email: "labeler-local-e2e@example.com" };
const other = { id: "00000000-0000-4000-8000-0000000000c2", email: "second-labeler@example.com" };

// a 1x1 PNG for every stored image
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==", "base64");

type Row = Record<string, unknown>;
const image = (id: number, run_id: number, dataset_id: number, tile_id: number | null, kind: string, prediction_label_id: number | null = null) => ({
  id,
  run_id,
  dataset_id,
  tile_id,
  prediction_label_id,
  kind,
  storage_path: `audit/bench/${id}.png`,
  width: 1,
  height: 1,
});
// tile 10N sits on dataset 50N; the prediction check's run on 501 is 55, on 502 54 (an older one), on 503 56, on 504 57
const TILE_RUNS: Record<number, number> = { 101: 55, 102: 54, 103: 56, 104: 57 };
const TILE_IMAGES = [101, 102, 103, 104].flatMap((tile) => [
  image(tile * 10, TILE_RUNS[tile], tile + 400, tile, "raw"),
  image(tile * 10 + 1, TILE_RUNS[tile], tile + 400, tile, "deadwood_overlay", 7001),
  image(tile * 10 + 2, TILE_RUNS[tile], tile + 400, tile, "forest_cover_overlay", 7002),
]);
// the dataset evaluation's runs: 77 on 601 (in the benchmark), 78 on 602 (not yet)
const DATASET_IMAGES = [
  image(6010, 77, 601, null, "overview"),
  image(6011, 77, 601, null, "thumbnail"),
  ...[900, 901, 902, 903].map((t, i) => image(6012 + i, 77, 601, t, "raw")),
  image(6020, 78, 602, null, "overview"),
];
const CURRENT_RUNS = [
  { dataset_id: 601, check_key: "dataset_evaluation", run_id: 77 },
  { dataset_id: 602, check_key: "dataset_evaluation", run_id: 78 },
];
const tileReview = (id: number, tile_id: number, layer: string, over: Row = {}) => ({
  id,
  dataset_id: tile_id + 400,
  tile_id,
  layer,
  prediction_label_id: layer === "deadwood" ? 7001 : 7002,
  verdict: "ok",
  problems: {},
  note: null,
  in_benchmark: true,
  reviewed_by: other.id,
  created_at: "2026-11-20T10:00:00Z",
  ...over,
});
// with labeled: the second labeler labeled tile 101 fine on both layers, tile 102's deadwood
// major, and dataset 601 OK
const TILE_LABELS = [
  tileReview(2, 101, "deadwood"),
  tileReview(3, 101, "forest_cover"),
  tileReview(5, 102, "deadwood", { verdict: "major", problems: { m1_dead_missed: true } }),
];
const DATASET_LABELS = [
  {
    id: 6,
    dataset_id: 601,
    check_key: "dataset_evaluation",
    decision: "keep",
    exclude_reason: null,
    cog_issue: false,
    thumbnail_issue: false,
    georef_status: null,
    date_replace: null,
    note: "sharp",
    in_benchmark: true,
    reviewed_by: other.id,
    created_at: "2026-11-20T10:00:00Z",
  },
];
const judgement = (id: number, tile_id: number, layer: string, judge: string, verdict: string) => ({
  id,
  run_id: TILE_RUNS[tile_id],
  tile_id,
  layer,
  judge,
  verdict,
  problems: { m1_dead_missed: { likelihood: verdict === "major" ? 85 : 5 } },
  summary: `${judge} says ${verdict}`,
});
// Luna called tile 101's deadwood major; Haiku judged the tiles not in the benchmark yet
const JUDGEMENTS = [
  judgement(9, 101, "deadwood", "luna-medium", "major"),
  ...[103, 104].flatMap((t, i) => [judgement(20 + i * 2, t, "deadwood", "haiku-4.5", "minor"), judgement(21 + i * 2, t, "forest_cover", "haiku-4.5", "ok")]),
];

// the reviews of a test (seeded, then the inserts), the inserts alone, and the rpc calls made
let tileReviews: Row[] = [];
let datasetReviews: Row[] = [];
let saved: Row[] = [];
let rpcCalls: { name: string; body: Row }[] = [];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "content-range": "0-0/1" }, json: body });

/** The rows a PostgREST query asks for: its eq. and in.() filters, and its order. */
function query(url: URL, rows: Row[]): Row[] {
  let out = rows;
  for (const [column, value] of url.searchParams) {
    if (["select", "order", "limit", "offset", "columns"].includes(column)) continue;
    if (value.startsWith("eq.")) out = out.filter((r) => String(r[column]) === value.slice(3));
    if (value.startsWith("in.(")) {
      const list = value.slice(4, -1).split(",");
      out = out.filter((r) => list.includes(String(r[column])));
    }
  }
  const order = url.searchParams.get("order");
  if (order) {
    const [column, direction] = order.split(".");
    out = [...out].sort((a, b) => (Number(a[column]) - Number(b[column])) * (direction === "desc" ? -1 : 1));
  }
  return out;
}

/** The newest review per dataset and check, as audit.current_dataset_human_reviews has it. */
const currentDatasetReviews = () =>
  [...datasetReviews].sort((a, b) => Number(b.id) - Number(a.id)).filter((r, i, all) => all.findIndex((o) => o.dataset_id === r.dataset_id && o.check_key === r.check_key) === i);

/** audit.draw_target: the first target not ticked and not skipped (random in the database). */
function draw(body: { p_benchmark: string; p_skipped: number[] }) {
  if (body.p_benchmark === "dataset_evaluation") {
    const ticked = new Set(datasetReviews.filter((r) => r.in_benchmark).map((r) => r.dataset_id));
    return [601, 602].filter((id) => !ticked.has(id) && !body.p_skipped.includes(id)).slice(0, 1).map((dataset_id) => ({ dataset_id, tile_id: null }));
  }
  const ticked = new Set(tileReviews.filter((r) => r.in_benchmark && r.layer === body.p_benchmark).map((r) => r.tile_id));
  return [103, 104].filter((id) => !ticked.has(id) && !body.p_skipped.includes(id)).slice(0, 1).map((tile_id) => ({ dataset_id: tile_id + 400, tile_id }));
}

async function mockSupabase(page: Page, { operator = false, labeled = false, excluded = false } = {}) {
  // copies: a removal clears the tick on the test's own rows
  tileReviews = labeled ? TILE_LABELS.map((r) => ({ ...r })) : [];
  datasetReviews = labeled ? DATASET_LABELS.map((r) => ({ ...r })) : [];
  await installLocalSession(page, { user: auditor, supabaseUrl: localSupabaseUrl, refreshToken: "benchmark-local-e2e", acceptCookies: true });
  await page.route("**/audit/images/access", (route) => json(route, { files_url: "/bench-files", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  await page.route("**/bench-files/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.pathname.split("/").at(-1);
    const object = request.headers()["accept"]?.includes("vnd.pgrst.object");
    const post = request.method() === "POST";
    if (resource === "privileged_users") return json(route, { user_id: auditor.id, can_audit: true, can_operate: operator });
    if (resource === "get_user_emails") return json(route, [other, auditor].map((u) => ({ user_id: u.id, email: u.email })));
    if (resource === "draw_target" || resource === "remove_benchmark_target") {
      const body = request.postDataJSON() as Row;
      rpcCalls.push({ name: resource, body });
      if (resource === "draw_target") return json(route, draw(body as { p_benchmark: string; p_skipped: number[] }));
      for (const r of tileReviews) if (r.tile_id === body.p_tile_id && r.layer === body.p_benchmark) r.in_benchmark = false;
      return json(route, 1);
    }
    if (resource === "tile_human_reviews" && post) {
      const row = { id: 1000 + saved.length, reviewed_by: auditor.id, created_at: "2026-11-26T10:00:00Z", note: null, ...(request.postDataJSON() as Row) };
      saved.push(row);
      tileReviews.push(row);
      return json(route, object ? row : [row], 201);
    }
    if (resource === "dataset_human_reviews" && post) {
      const rows = (request.postDataJSON() as Row[]).map((r, i) => ({ id: 1000 + saved.length + i, reviewed_by: auditor.id, created_at: "2026-11-26T10:00:00Z", ...r }));
      saved.push(...rows);
      datasetReviews.push(...rows);
      return json(route, rows, 201);
    }
    const tables: Record<string, () => Row[]> = {
      tile_human_reviews: () => tileReviews,
      dataset_human_reviews: () => datasetReviews,
      current_dataset_human_reviews: currentDatasetReviews,
      current_runs: () => CURRENT_RUNS,
      images: () => [...TILE_IMAGES, ...DATASET_IMAGES],
      tile_vlm_judgements: () => JUDGEMENTS,
      dataset_vlm_judgements: () => [],
      // with excluded: the audit decision on dataset 502 is exclude
      dataset_outcomes: () => (excluded ? [{ dataset_id: 502, evaluation_decision: "exclude" }] : []),
    };
    const rows = tables[resource ?? ""];
    if (rows) return json(route, query(url, rows()));
    return json(route, object ? null : []);
  });
}

test.describe("benchmark labeling", () => {
  test.beforeEach(() => {
    saved = [];
    rpcCalls = [];
  });

  const drawn = () => rpcCalls.filter((c) => c.name === "draw_target").map((c) => c.body.p_skipped);
  const removals = () => rpcCalls.filter((c) => c.name === "remove_benchmark_target").map((c) => [c.body.p_benchmark, c.body.p_dataset_id, c.body.p_tile_id]);

  test("the tab lists each benchmark's labels, and only operators add new random tiles", async ({ page }) => {
    await mockSupabase(page, { labeled: true });
    await page.goto("/dataset-audit?tab=benchmark");
    await expect(page.getByTestId("benchmark-count-deadwood")).toHaveText("2");
    await expect(page.getByTestId("benchmark-count-forest_cover")).toHaveText("1");
    await expect(page.getByTestId("benchmark-count-dataset_evaluation")).toHaveText("1");
    const tile102 = page.getByTestId("benchmark-table-deadwood").getByRole("row", { name: /102/ });
    await expect(tile102).toContainText("Major");
    await expect(tile102).toContainText("Dead trees missed");
    await expect(tile102).toContainText("second-labeler");
    await expect(page.getByTestId("benchmark-table-dataset_evaluation")).toContainText("sharp");
    // no audit list on this tab, and no new tiles from auditors who do not operate
    await expect(page.getByTestId("audit-review-table")).toHaveCount(0);
    await expect(page.getByTestId("benchmark-card-deadwood").getByRole("button", { name: "Label new random tiles" })).toBeDisabled();
    await page.getByTestId("benchmark-card-deadwood").getByRole("button", { name: "Review existing labels" }).click();
    await expect(page).toHaveURL(/\/dataset-audit\/benchmark\/deadwood\?mode=review/);
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 2");
  });

  test("an operator labels new random tiles blind: each label is a review ticked for the benchmark", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit?tab=benchmark");
    await page.getByTestId("benchmark-card-deadwood").getByRole("button", { name: "Label new random tiles" }).click();
    await expect(page).toHaveURL(/\/dataset-audit\/benchmark\/deadwood\?mode=new/);
    // one random tile at a time, drawn by the database
    await expect(page.getByTestId("crop-images").getByRole("img")).toHaveCount(2);
    await expect(page.getByTestId("crop-position")).toHaveCount(0);
    await expect(page.getByTestId("benchmark-position")).toHaveCount(0);
    // blind: nothing of the models before the label, and no problem pre-ticked
    await expect(page.getByText("Labeled blind")).toBeVisible();
    await expect(page.getByTestId("audit-crop-findings")).toHaveCount(0);

    // dead trees missed: yes, and major saves the tile; the deadwood benchmark asks nothing of tree cover
    await page.keyboard.press("y");
    await page.keyboard.press("3");
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toEqual(
      expect.objectContaining({ dataset_id: 503, tile_id: 103, layer: "deadwood", prediction_label_id: 7001, verdict: "major", problems: { m1_dead_missed: true }, in_benchmark: true }),
    );
    expect(saved[0]).not.toHaveProperty("evidence_key");

    // the next random tile is drawn, blind again; 4 stores ambiguous
    await expect(page.getByTestId("crop-images").getByRole("img").first()).toHaveAttribute("src", /bench\/1040\.png/);
    await expect(page.getByText("Labeled blind")).toBeVisible();
    await page.keyboard.press("4");
    await expect.poll(() => saved.length).toBe(2);
    expect(saved[1]).toMatchObject({ layer: "deadwood", verdict: "ambiguous", tile_id: 104, in_benchmark: true });
    // no tile left that is not in the benchmark
    await expect(page.getByText("No tiles left that are not in the benchmark yet.")).toBeVisible();
    expect(removals()).toEqual([]);
  });

  test("Skip draws another random tile without labeling, and a skipped tile does not come back", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=new");
    const raw = page.getByTestId("crop-images").getByRole("img").first();
    await expect(raw).toHaveAttribute("src", /bench\/1030\.png/);
    await page.keyboard.press("k");
    await expect(raw).toHaveAttribute("src", /bench\/1040\.png/);
    await page.getByTestId("benchmark-skip").click();
    await expect(page.getByText("No tiles left that are not in the benchmark yet.")).toBeVisible();
    // the skipped tiles go to the draw
    expect(drawn()).toEqual([[], [103], [103, 104]]);
    expect(saved).toHaveLength(0);
  });

  test("the tree cover benchmark labels tree cover only", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit/benchmark/forest_cover?mode=new");
    await expect(page.getByTestId("crop-images").getByRole("img")).toHaveCount(2);
    await expect(page.getByText("Tree cover prediction").first()).toBeVisible();
    await page.keyboard.press("1");
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ layer: "forest_cover", verdict: "ok", prediction_label_id: 7002, in_benchmark: true });
    expect(drawn()[0]).toEqual([]);
    expect(rpcCalls[0].body.p_benchmark).toBe("forest_cover");
  });

  test("auditors who do not operate cannot label new random tiles", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit/benchmark/deadwood?mode=new");
    await expect(page.getByText("Adding to a benchmark is for operators")).toBeVisible();
    await expect(page.getByTestId("crop-reviewer")).toHaveCount(0);
    expect(drawn()).toEqual([]);
  });

  test("a new random dataset is labeled for the dataset evaluation benchmark", async ({ page }) => {
    await mockSupabase(page, { operator: true, labeled: true });
    await page.goto("/dataset-audit/benchmark/dataset_evaluation?mode=new");
    // 601 is in the benchmark: 602 is the one new dataset
    await expect(page.getByText("Dataset 602 ↗")).toBeVisible();
    await page.keyboard.press("2");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Excluding needs a reason")).toBeVisible();
    await page.keyboard.press("q");
    await page.keyboard.press("Enter");
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toEqual({
      id: expect.any(Number),
      reviewed_by: auditor.id,
      created_at: expect.any(String),
      dataset_id: 602,
      check_key: "dataset_evaluation",
      decision: "exclude",
      exclude_reason: "blurry",
      cog_issue: false,
      thumbnail_issue: false,
      note: null,
      in_benchmark: true,
    });
    // and then no dataset is left to draw
    await expect(page.getByText("No datasets left that are not in the benchmark yet.")).toBeVisible();
  });

  test("a label is the newest answer, whoever gave it, which a new answer replaces", async ({ page }) => {
    await mockSupabase(page, { labeled: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review&target=tile-101");
    await expect(page.getByTestId("crop-position")).toHaveText("Crop 1 of 2");
    await expect(page.getByTestId("benchmark-labeled-by")).toContainText("second-labeler");
    await expect(page.getByTestId("audit-crop-findings").first()).toContainText("Luna");
    await page.keyboard.press("3");
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ tile_id: 101, layer: "deadwood", verdict: "major", in_benchmark: true });
    // every tile in review has a label: saving goes on to the next one in the list
    await expect(page.getByTestId("crop-position")).toHaveText("Crop 2 of 2");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("benchmark-labeled-by")).toContainText("labeler-local-e2e");
    expect(removals()).toEqual([]);
  });

  test("tiles of an excluded dataset leave the tile benchmarks while the exclusion stands", async ({ page }) => {
    await mockSupabase(page, { labeled: true, excluded: true });
    await page.goto("/dataset-audit?tab=benchmark");
    await expect(page.getByTestId("benchmark-count-deadwood")).toHaveText("1");
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review");
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 1");
    // auditors who are no operators cannot remove, by button or key
    await expect(page.getByTestId("benchmark-remove")).toHaveCount(0);
    await page.keyboard.press("Delete");
    await expect(page.getByText("Remove from the benchmark?")).toHaveCount(0);
  });

  test("an operator removes a tile after confirming, and Undo ticks its label again", async ({ page }) => {
    await mockSupabase(page, { operator: true, labeled: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review");
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 2");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("crop-position")).toHaveText("Crop 2 of 2");

    // Delete asks first; Cancel removes nothing
    await page.keyboard.press("Delete");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Crop 102 of dataset 502 leaves the deadwood prediction benchmark");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(removals()).toEqual([]);

    await page.getByTestId("benchmark-remove").click();
    await page.getByTestId("benchmark-remove-confirm").click();
    await expect.poll(removals).toEqual([["deadwood", 502, 102]]);
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 1");
    // a dataset with one tile offers no "remove all its crops"
    await page.getByTestId("benchmark-remove").click();
    await expect(page.getByTestId("benchmark-remove-dataset")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    // Undo stores the label again, ticked
    await page.getByTestId("benchmark-undo-remove").click();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ tile_id: 102, layer: "deadwood", verdict: "major", problems: { m1_dead_missed: true }, in_benchmark: true });
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 2");
    await expect(page.getByTestId("benchmark-undo-remove")).toHaveCount(0);
  });

  test("Undo still works after removing the last label shown", async ({ page }) => {
    await mockSupabase(page, { operator: true, labeled: true, excluded: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review");
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 1");
    await page.keyboard.press("Delete");
    await page.getByTestId("benchmark-remove-confirm").click();
    await expect(page.getByText("The benchmark has no labeled tiles yet.")).toBeVisible();
    await expect(page.getByTestId("benchmark-remove")).toHaveCount(0);
    await page.getByTestId("benchmark-undo-remove").click();
    await expect.poll(() => saved.map((r) => r.tile_id)).toEqual([101]);
    expect(removals()).toEqual([["deadwood", 501, 101]]);
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 1");
  });

  test("the confirm step holds its tile while the keys behind it are pressed", async ({ page }) => {
    await mockSupabase(page, { operator: true, labeled: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review");
    await expect(page.getByTestId("crop-position")).toHaveText("Crop 1 of 2");
    await page.keyboard.press("Delete");
    await expect(page.getByRole("dialog")).toContainText("Crop 101 of dataset 501");
    // the crop review's keys do not reach the page while the dialog asks
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog")).toContainText("Crop 101 of dataset 501");
    await page.getByTestId("benchmark-remove-confirm").click();
    await expect.poll(removals).toEqual([["deadwood", 501, 101]]);
  });
});
