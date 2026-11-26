import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

// Benchmark labeling on the audit page (docs/audit-checks.md, Benchmarks), against mocked
// Supabase and API responses: nothing is written anywhere.

const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const auditor = { id: "00000000-0000-4000-8000-0000000000c1", email: "labeler-local-e2e@example.com" };
const other = { id: "00000000-0000-4000-8000-0000000000c2", email: "second-labeler@example.com" };

// a 1x1 PNG for every stored image
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==", "base64");
// prediction quality has a benchmark per layer; the tree cover one holds crop 101 only
const BENCHMARKS = [
  { id: 1, check_key: "prediction_quality", layer: "deadwood", name: "pq-deadwood-gold", version: "v1" },
  { id: 3, check_key: "prediction_quality", layer: "forest_cover", name: "pq-forest-cover-gold", version: "v1" },
  { id: 2, check_key: "dataset_evaluation", layer: null, name: "dataset-evaluation-gold", version: "v1" },
];
const MEMBERS: Record<number, unknown[]> = {
  1: [
    { id: 11, dataset_id: 501, crop_id: 101, split: "dev" },
    { id: 12, dataset_id: 502, crop_id: 102, split: "holdout" },
  ],
  3: [{ id: 31, dataset_id: 501, crop_id: 101, split: "dev" }],
  2: [{ id: 21, dataset_id: 601, crop_id: null, split: "dev" }],
};
const image = (id: number, crop: number | null, dataset: number, kind: string, label: number | null = null) => ({
  id,
  crop_id: crop,
  dataset_id: dataset,
  label_id: label,
  kind,
  storage_path: `audit/bench/${id}.png`,
  width: 1,
  height: 1,
  ortho_sha256: "a".repeat(64),
});
// crop 10N sits on dataset 50N
const CROP_IMAGES = [101, 102, 103, 104].flatMap((crop) => [
  image(crop * 10, crop, crop + 400, "raw"),
  image(crop * 10 + 1, crop, crop + 400, "deadwood_overlay", 7001),
  image(crop * 10 + 2, crop, crop + 400, "forest_cover_overlay", 7002),
]);
const DATASET_IMAGES = [image(6010, null, 601, "overview"), image(6011, null, 601, "thumbnail"), ...[900, 901, 902, 903].map((c, i) => image(6012 + i, c, 601, "raw"))];
const SHA = "a".repeat(64);
const crop = (id: number, dataset: number, set: string) => ({ id, dataset_id: dataset, crop_sets: [set], ortho_sha256: SHA, geometry: null });
const CROPS = [
  crop(101, 501, "exclude"),
  crop(102, 502, "benchmark"),
  crop(103, 503, "exclude"),
  crop(104, 504, "exclude"),
  ...[900, 901, 902, 903].map((id) => crop(id, 601, "evaluation")),
];
// the checks' current runs: prediction quality on 501, 503 and 504 (502's crop is a gold crop no
// run judged), the dataset evaluation on 601 (in the benchmark) and 602 (not yet)
const CURRENT: Record<string, { dataset_id: number; run_id: number }[]> = {
  prediction_quality: [
    { dataset_id: 501, run_id: 55 },
    { dataset_id: 503, run_id: 56 },
    { dataset_id: 504, run_id: 57 },
  ],
  dataset_evaluation: [
    { dataset_id: 601, run_id: 77 },
    { dataset_id: 602, run_id: 78 },
  ],
};
const evaluationRun = (id: number) => ({
  id,
  check_key: "dataset_evaluation",
  inputs: { ortho_sha256: SHA },
  // a rerun of the evaluation: it kept the first overview row but judged its own overview file,
  // and picked other crops (901, 902) than the earlier run (900, 903)
  evidence: { judged: { crop_ids: [901, 902], images: [{ crop_id: null, label_id: null, kind: "overview", storage_path: `audit/bench/run-${id}-overview.png` }] } },
});
const RUNS = [...[55, 56, 57].map((id) => ({ id, check_key: "prediction_quality", inputs: { ortho_sha256: SHA }, evidence: {} })), evaluationRun(77), evaluationRun(78)];
const row = (overrides: Record<string, unknown>) => ({
  id: 1,
  check_key: "prediction_quality",
  dataset_id: 501,
  crop_id: 101,
  run_id: null,
  layer: "image",
  label_id: null,
  assessor_kind: "person",
  assessor_user_id: other.id,
  model: null,
  prompt_version: null,
  assessor: other.id,
  verdict: "ok",
  major_likelihood: null,
  modes: {},
  reason_code: null,
  reason_text: null,
  details: {},
  created_at: "2026-11-20T10:00:00Z",
  ...overrides,
});
// with labeled: the second labeler labeled crop 101 fine on both layers, crop 102's deadwood
// major, and dataset 601 OK
const LABELS = [
  row({ id: 1 }),
  row({ id: 2, layer: "deadwood", label_id: 7001 }),
  row({ id: 3, layer: "forest_cover", label_id: 7002 }),
  row({ id: 4, dataset_id: 502, crop_id: 102 }),
  row({ id: 5, dataset_id: 502, crop_id: 102, layer: "deadwood", label_id: 7001, verdict: "major", modes: { m1_dead_missed: true } }),
  row({ id: 6, check_key: "dataset_evaluation", dataset_id: 601, crop_id: null, reason_text: "sharp" }),
];
const model = (id: number, cropId: number, runId: number, layer: string, name: string, verdict: string) =>
  row({
    id,
    dataset_id: cropId + 400,
    crop_id: cropId,
    layer,
    assessor_kind: "model",
    assessor_user_id: null,
    model: name,
    prompt_version: "pq-v5",
    assessor: `${name}/pq-v5`,
    run_id: runId,
    verdict,
    major_likelihood: verdict === "major" ? 80 : 10,
    modes: { m1_dead_missed: { likelihood: verdict === "major" ? 85 : 5 } },
  });
// Luna counted crop 101's deadwood major; Haiku judged the crops not in the benchmark yet
const MODELS = [
  model(9, 101, 55, "deadwood", "luna-medium", "major"),
  ...[103, 104].flatMap((c, i) => [model(20 + i * 2, c, 56 + i, "deadwood", "haiku-4.5", "minor"), model(21 + i * 2, c, 56 + i, "forest_cover", "haiku-4.5", "ok")]),
];

let saved: Record<string, unknown>[] = [];
// crops taken out with audit.remove_benchmark_target, and the rpc calls made
let removedCrops = new Set<number>();
let rpcCalls: { name: string; body: Record<string, unknown> }[] = [];
// members a test added with audit.add_benchmark_target, by benchmark
let added: Record<number, { id: number; dataset_id: number; crop_id: number | null; split: string }[]> = {};
const benchmarkOf = (layer: string | null) => BENCHMARKS.find((b) => b.layer === layer)!.id;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "content-range": "0-0/1" }, json: body });
const inText = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith("in.(") ? value.slice(4, -1).split(",") : null;
};
const inList = (url: URL, column: string) => inText(url, column)?.map(Number) ?? null;
const eqText = (url: URL, column: string) => url.searchParams.get(column)?.replace(/^eq\./, "") ?? null;
// a layer's benchmark reads that layer's rows and "can't tell" (layer image)
const onLayers = <T extends { layer: string }>(url: URL, rows: T[]) => {
  const layers = inText(url, "layer");
  return layers ? rows.filter((r) => layers.includes(r.layer)) : rows;
};
// the rows a query by crops, or by datasets (crop_id is null), asks for
const onTargets = (url: URL, rows: ReturnType<typeof row>[]) => {
  const crops = inList(url, "crop_id");
  const datasets = inList(url, "dataset_id");
  return onLayers(url, rows).filter((r) => (crops ? crops.includes(r.crop_id as number) : !!datasets?.includes(r.dataset_id as number) && r.crop_id === null));
};

async function mockSupabase(page: Page, { operator = false, labeled = false, excluded = false } = {}) {
  await installLocalSession(page, { user: auditor, supabaseUrl: localSupabaseUrl, refreshToken: "benchmark-local-e2e", acceptCookies: true });
  await page.route("**/audit/images/access", (route) => json(route, { files_url: "/bench-files", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  await page.route("**/bench-files/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.pathname.split("/").at(-1);
    const object = request.headers()["accept"]?.includes("vnd.pgrst.object");
    if (resource === "privileged_users") return json(route, { user_id: auditor.id, can_audit: true, can_operate: operator });
    if (resource === "remove_benchmark_target" || resource === "add_benchmark_target") {
      const body = request.postDataJSON() as { p_dataset_id: number; p_crop_id: number | null; p_layer: string | null };
      rpcCalls.push({ name: resource, body });
      const rows = MEMBERS[1].filter((m) => {
        const member = m as { dataset_id: number; crop_id: number };
        return member.dataset_id === body.p_dataset_id && (body.p_crop_id === null || member.crop_id === body.p_crop_id);
      }) as { crop_id: number }[];
      for (const row of rows) (resource === "remove_benchmark_target" ? removedCrops.add(row.crop_id) : removedCrops.delete(row.crop_id));
      if (resource === "remove_benchmark_target") return json(route, rows);
      if (rows[0]) return json(route, rows[0]);
      // a target new to the benchmark gets a new member row
      const member = { id: 900 + rpcCalls.length, dataset_id: body.p_dataset_id, crop_id: body.p_crop_id, split: "dev" };
      (added[benchmarkOf(body.p_layer)] ??= []).push(member);
      return json(route, member);
    }
    if (resource === "get_user_emails") return json(route, [other, auditor].map((u) => ({ user_id: u.id, email: u.email })));
    if (resource === "benchmarks") return json(route, BENCHMARKS);
    if (resource === "benchmark_members") {
      const id = Number(url.searchParams.get("benchmark_id")?.slice(3));
      const members = [...(MEMBERS[id] ?? []), ...(added[id] ?? [])] as { crop_id: number | null }[];
      return json(route, members.filter((m) => m.crop_id === null || !removedCrops.has(m.crop_id)));
    }
    if (resource === "images") {
      const crops = inList(url, "crop_id");
      return json(route, crops ? CROP_IMAGES.filter((i) => crops.includes(i.crop_id!)) : DATASET_IMAGES);
    }
    if (resource === "current_runs") {
      const datasets = inList(url, "dataset_id");
      return json(route, (CURRENT[eqText(url, "check_key") ?? ""] ?? []).filter((c) => !datasets || datasets.includes(c.dataset_id)));
    }
    if (resource === "runs") return json(route, RUNS.filter((r) => inList(url, "id")?.includes(r.id)));
    if (resource === "crops") {
      const ids = inList(url, "id");
      return json(route, ids ? CROPS.filter((c) => ids.includes(c.id)) : CROPS.filter((c) => c.crop_sets.includes("evaluation")));
    }
    // with excluded: the audit decision on dataset 502 is exclude
    if (resource === "dataset_results") return json(route, excluded && eqText(url, "evaluation_decision") === "exclude" ? [{ dataset_id: 502 }] : []);
    if (resource === "latest_assessments") return json(route, labeled ? onTargets(url, LABELS.filter((l) => l.check_key === eqText(url, "check_key"))) : []);
    if (resource === "assessments" && request.method() === "POST") {
      const rows = (request.postDataJSON() as Record<string, unknown>[]).map((r, i) => ({
        ...row({}),
        ...r,
        id: 1000 + saved.length + i,
        assessor: auditor.id,
        assessor_user_id: auditor.id,
      }));
      saved.push(...rows);
      return json(route, rows, 201);
    }
    if (resource === "assessments") {
      // sampling: the crops a run judged on a layer
      const runs = inList(url, "run_id");
      if (runs) return json(route, MODELS.filter((m) => runs.includes(m.run_id as number) && m.layer === eqText(url, "layer")));
      return json(route, onTargets(url, MODELS));
    }
    return json(route, object ? null : []);
  });
}

test.describe("benchmark labeling", () => {
  test.beforeEach(() => {
    saved = [];
    removedCrops = new Set();
    rpcCalls = [];
    added = {};
  });

  test("the tab lists each benchmark's labels, and only operators add new random tiles", async ({ page }) => {
    await mockSupabase(page, { labeled: true });
    await page.goto("/dataset-audit?tab=benchmark");
    await expect(page.getByTestId("benchmark-count-deadwood")).toHaveText("2");
    await expect(page.getByTestId("benchmark-count-tree_cover")).toHaveText("1");
    await expect(page.getByTestId("benchmark-count-dataset_evaluation")).toHaveText("1");
    const crop102 = page.getByTestId("benchmark-table-deadwood").getByRole("row", { name: /102/ });
    await expect(crop102).toContainText("Major");
    await expect(crop102).toContainText("Dead trees missed");
    await expect(crop102).toContainText("second-labeler");
    await expect(page.getByTestId("benchmark-table-dataset_evaluation")).toContainText("sharp");
    // no audit list on this tab, and no new tiles from auditors who do not operate
    await expect(page.getByTestId("audit-review-table")).toHaveCount(0);
    await expect(page.getByTestId("benchmark-card-deadwood").getByRole("button", { name: "Label new random tiles" })).toBeDisabled();
    await page.getByTestId("benchmark-card-deadwood").getByRole("button", { name: "Review existing labels" }).click();
    await expect(page).toHaveURL(/\/dataset-audit\/benchmark\/deadwood\?mode=review/);
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 2");
  });

  test("members without a label are neither shown nor scored", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit?tab=benchmark");
    await expect(page.getByTestId("benchmark-count-deadwood")).toHaveText("0");
    await expect(page.getByTestId("benchmark-unlabeled-deadwood")).toContainText("2 tiles added earlier without a label");
  });

  test("an operator labels new random tiles blind: each joins the benchmark with its label", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit?tab=benchmark");
    await page.getByTestId("benchmark-card-deadwood").getByRole("button", { name: "Label new random tiles" }).click();
    await expect(page).toHaveURL(/\/dataset-audit\/benchmark\/deadwood\?mode=new/);
    // one random tile at a time, of a dataset with a judged tile not in the benchmark: 503 or 504
    await expect(page.getByTestId("crop-images").getByRole("img")).toHaveCount(2);
    await expect(page.getByTestId("crop-position")).toHaveCount(0);
    await expect(page.getByTestId("benchmark-position")).toHaveCount(0);
    await expect(page.getByTestId("crop-images").getByRole("img")).toHaveCount(2);
    // blind: nothing of the models before the label, and no problem pre-ticked
    await expect(page.getByText("Labeled blind")).toBeVisible();
    await expect(page.getByTestId("audit-crop-findings")).toHaveCount(0);

    // dead trees missed: yes, and major saves the tile; the deadwood benchmark asks nothing of tree cover
    await page.keyboard.press("y");
    await page.keyboard.press("3");
    await expect.poll(() => saved.length).toBe(2);
    const first = saved[0].crop_id as number;
    expect([103, 104]).toContain(first);
    const run = first === 103 ? 56 : 57;
    expect(saved.map((r) => [r.layer, r.verdict, r.modes, r.run_id, r.crop_id, r.label_id ?? null])).toEqual([
      ["image", "ok", {}, run, first, null],
      ["deadwood", "major", { m1_dead_missed: true }, run, first, 7001],
    ]);
    // the label is stored first, then the tile joins the benchmark
    await expect.poll(() => rpcCalls.map((c) => [c.name, c.body.p_crop_id, c.body.p_layer])).toEqual([["add_benchmark_target", first, "deadwood"]]);

    // the next random tile is drawn, blind again; 4 stores ambiguous
    await expect(page.getByText("Labeled blind")).toBeVisible();
    await page.keyboard.press("4");
    await expect.poll(() => saved.length).toBe(4);
    expect(saved[3]).toMatchObject({ layer: "deadwood", verdict: "ambiguous", crop_id: first === 103 ? 104 : 103 });
    await expect.poll(() => rpcCalls.length).toBe(2);
    // no tile left that is not in the benchmark
    await expect(page.getByText("No tiles left that are not in the benchmark yet.")).toBeVisible();
  });

  test("Skip draws another random tile without labeling, and a skipped tile does not come back", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=new");
    const raw = page.getByTestId("crop-images").getByRole("img").first();
    await expect(raw).toHaveAttribute("src", /bench\/10[34]0\.png/);
    const first = (await raw.getAttribute("src"))!.includes("1030") ? "1030" : "1040";
    await page.keyboard.press("k");
    await expect(raw).toHaveAttribute("src", new RegExp(`bench/${first === "1030" ? "1040" : "1030"}\\.png`));
    await page.getByTestId("benchmark-skip").click();
    await expect(page.getByText("No tiles left that are not in the benchmark yet.")).toBeVisible();
    expect(saved).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  test("the tree cover benchmark labels tree cover only", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit/benchmark/tree_cover?mode=new");
    await expect(page.getByTestId("crop-images").getByRole("img")).toHaveCount(2);
    await expect(page.getByText("Tree cover prediction").first()).toBeVisible();
    await page.keyboard.press("1");
    await expect.poll(() => saved.length).toBe(2);
    expect(saved.map((r) => [r.layer, r.verdict, r.label_id ?? null])).toEqual([
      ["image", "ok", null],
      ["forest_cover", "ok", 7002],
    ]);
    await expect.poll(() => rpcCalls.map((c) => c.body.p_layer)).toEqual(["forest_cover"]);
  });

  test("auditors who do not operate cannot label new random tiles", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit/benchmark/deadwood?mode=new");
    await expect(page.getByText("Adding to a benchmark is for operators")).toBeVisible();
    await expect(page.getByTestId("crop-reviewer")).toHaveCount(0);
  });

  test("a new random dataset is labeled for the dataset evaluation benchmark", async ({ page }) => {
    await mockSupabase(page, { operator: true });
    await page.goto("/dataset-audit/benchmark/dataset_evaluation?mode=new");
    // 601 is in the benchmark: 602 is the one new dataset
    await expect(page.getByText("Dataset 602 ↗")).toBeVisible();
    await page.keyboard.press("2");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Excluding needs a reason")).toBeVisible();
    await page.keyboard.press("q");
    await page.keyboard.press("Enter");
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ check_key: "dataset_evaluation", dataset_id: 602, crop_id: null, layer: "image", verdict: "major", reason_code: "blurry", run_id: 78 });
    await expect.poll(() => rpcCalls.map((c) => [c.name, c.body.p_dataset_id, c.body.p_crop_id])).toEqual([["add_benchmark_target", 602, null]]);
    // and then no dataset is left to draw
    await expect(page.getByText("No datasets left that are not in the benchmark yet.")).toBeVisible();
  });

  test("a label is the latest answer, whoever gave it, which a new answer replaces", async ({ page }) => {
    await mockSupabase(page, { labeled: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review&target=crop-101");
    await expect(page.getByTestId("crop-position")).toHaveText("Crop 1 of 2");
    await expect(page.getByTestId("benchmark-labeled-by")).toContainText("second-labeler");
    await expect(page.getByTestId("audit-crop-findings").first()).toContainText("Luna");
    await page.keyboard.press("3");
    await expect.poll(() => saved.length).toBe(2);
    await expect(page.getByTestId("benchmark-labeled-by")).toContainText("labeler-local-e2e");
    // a member already: nothing joins
    expect(rpcCalls).toHaveLength(0);
  });

  test("crops of an excluded dataset leave the crop benchmarks while the exclusion stands", async ({ page }) => {
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

  test("an operator removes a crop after confirming, and Undo brings it back", async ({ page }) => {
    await mockSupabase(page, { operator: true, labeled: true });
    await page.goto("/dataset-audit/benchmark/deadwood?mode=review");
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 2");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("crop-position")).toHaveText("Crop 2 of 2");

    // Delete asks first; Cancel removes nothing
    await page.keyboard.press("Delete");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Crop 102 of dataset 502 leaves pq-deadwood-gold v1");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(rpcCalls).toHaveLength(0);

    await page.getByTestId("benchmark-remove").click();
    await page.getByTestId("benchmark-remove-confirm").click();
    await expect.poll(() => rpcCalls.map((c) => [c.name, c.body.p_crop_id, c.body.p_layer])).toEqual([["remove_benchmark_target", 102, "deadwood"]]);
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 1");
    // a dataset with one crop offers no "remove all its crops"
    await page.getByTestId("benchmark-remove").click();
    await expect(page.getByTestId("benchmark-remove-dataset")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    await page.getByTestId("benchmark-undo-remove").click();
    await expect.poll(() => rpcCalls.map((c) => c.name)).toEqual(["remove_benchmark_target", "add_benchmark_target"]);
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
    await expect.poll(() => rpcCalls.map((c) => [c.name, c.body.p_crop_id])).toEqual([
      ["remove_benchmark_target", 101],
      ["add_benchmark_target", 101],
    ]);
    await expect(page.getByTestId("benchmark-position")).toHaveText("1 / 1");
  });

  test("the confirm step holds its crop while the keys behind it are pressed", async ({ page }) => {
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
    await expect.poll(() => rpcCalls.map((c) => [c.name, c.body.p_dataset_id, c.body.p_crop_id])).toEqual([["remove_benchmark_target", 501, 101]]);
  });
});
