import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

// Benchmark labeling on the audit page (docs/audit-checks.md, Benchmarks), against mocked
// Supabase and API responses: nothing is written anywhere.

const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const auditor = { id: "00000000-0000-4000-8000-0000000000c1", email: "labeler-local-e2e@example.com" };
const other = { id: "00000000-0000-4000-8000-0000000000c2", email: "second-labeler@example.com" };

// a 1x1 PNG for every stored image
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==", "base64");
const BENCHMARKS = [
  { id: 1, check_key: "prediction_quality", name: "pq-gold-dt1272", version: "v2" },
  { id: 2, check_key: "dataset_evaluation", name: "dataset-evaluation-gold", version: "v1" },
];
const MEMBERS: Record<number, unknown[]> = {
  1: [
    { id: 11, dataset_id: 501, crop_id: 101, split: "dev" },
    { id: 12, dataset_id: 502, crop_id: 102, split: "holdout" },
  ],
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
const CROP_IMAGES = [101, 102].flatMap((crop, i) => [
  image(crop * 10, crop, 501 + i, "raw"),
  image(crop * 10 + 1, crop, 501 + i, "deadwood_overlay", 7001),
  image(crop * 10 + 2, crop, 501 + i, "forest_cover_overlay", 7002),
]);
const DATASET_IMAGES = [image(6010, null, 601, "overview"), image(6011, null, 601, "thumbnail"), image(6012, 900, 601, "raw")];
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
  ...overrides,
});
// the second labeler said crop 101 is fine; Luna counted its deadwood major
const OTHERS = [row({ id: 1 }), row({ id: 2, layer: "deadwood", label_id: 7001 }), row({ id: 3, layer: "forest_cover", label_id: 7002 })];
const MODELS = [
  row({
    id: 9,
    layer: "deadwood",
    assessor_kind: "model",
    assessor_user_id: null,
    model: "luna-medium",
    prompt_version: "pq-v5",
    assessor: "luna-medium/pq-v5",
    verdict: "major",
    major_likelihood: 80,
    modes: { m1_dead_missed: { likelihood: 85 } },
  }),
];

let saved: Record<string, unknown>[] = [];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "content-range": "0-0/1" }, json: body });
const inList = (url: URL, column: string) => {
  const value = url.searchParams.get(column);
  return value?.startsWith("in.(") ? value.slice(4, -1).split(",").map(Number) : null;
};

async function mockSupabase(page: Page) {
  await installLocalSession(page, { user: auditor, supabaseUrl: localSupabaseUrl, refreshToken: "benchmark-local-e2e", acceptCookies: true });
  await page.route("**/audit/images/access", (route) => json(route, { files_url: "/bench-files", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  await page.route("**/bench-files/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.pathname.split("/").at(-1);
    const object = request.headers()["accept"]?.includes("vnd.pgrst.object");
    if (resource === "privileged_users") return json(route, { user_id: auditor.id, can_audit: true, can_operate: false });
    if (resource === "get_user_emails") return json(route, [other, auditor].map((u) => ({ user_id: u.id, email: u.email })));
    if (resource === "benchmarks") return json(route, BENCHMARKS);
    if (resource === "benchmark_members") return json(route, MEMBERS[Number(url.searchParams.get("benchmark_id")?.slice(3))] ?? []);
    if (resource === "images") {
      const crops = inList(url, "crop_id");
      return json(route, crops ? CROP_IMAGES.filter((i) => crops.includes(i.crop_id!)) : DATASET_IMAGES);
    }
    if (resource === "crops") return json(route, [{ id: 900 }]);
    if (resource === "latest_assessments") return json(route, inList(url, "crop_id") ? OTHERS : []);
    if (resource === "assessments" && request.method() === "POST") {
      const rows = (request.postDataJSON() as Record<string, unknown>[]).map((r, i) => ({ ...row({}), ...r, id: 1000 + saved.length + i, assessor: auditor.id }));
      saved.push(...rows);
      return json(route, rows, 201);
    }
    if (resource === "assessments") return json(route, inList(url, "crop_id") ? MODELS : []);
    return json(route, object ? null : []);
  });
}

test.describe("benchmark labeling", () => {
  test.beforeEach(() => {
    saved = [];
  });

  test("the tab counts what is open for you and opens the labeler", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit?tab=benchmark");
    await expect(page.getByTestId("benchmark-open-prediction_quality")).toHaveText("2");
    await expect(page.getByTestId("benchmark-open-dataset_evaluation")).toHaveText("1");
    await page.getByTestId("benchmark-card-prediction_quality").getByRole("button", { name: "Label", exact: true }).click();
    await expect(page).toHaveURL(/\/dataset-audit\/benchmark\/prediction_quality\?filter=open/);
    await expect(page.getByTestId("benchmark-left")).toContainText("2 of 2 left for you");
  });

  test("a crop is labeled blind with the keys, and the others show after your answer", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit/benchmark/prediction_quality?filter=open");
    await expect(page.getByTestId("benchmark-crop")).toBeVisible();
    await expect(page.getByTestId("benchmark-crop-images").getByRole("img")).toHaveCount(3);
    // blind: nothing of the other labeler or Luna before your answer
    await expect(page.getByTestId("benchmark-reveal")).toHaveCount(0);

    // dead trees missed: yes; Enter wants minor or major first
    await page.keyboard.press("y");
    await page.keyboard.press("Enter");
    await expect(page.getByText("pick minor (2) or major (3)")).toBeVisible();
    expect(saved).toHaveLength(0);
    await page.keyboard.press("3");
    await page.keyboard.press("Enter");
    await expect.poll(() => saved.length).toBe(3);
    expect(saved.map((r) => [r.layer, r.verdict, r.modes, r.run_id, r.crop_id])).toEqual([
      ["image", "ok", {}, null, 101],
      ["deadwood", "major", { m1_dead_missed: true }, null, 101],
      ["forest_cover", "ok", {}, null, 101],
    ]);
    expect(saved[1].label_id).toBe(7001);
    // saved, on to the next open crop
    await expect(page.getByTestId("benchmark-position")).toHaveText("2 / 2");
    await expect(page.getByTestId("benchmark-left")).toContainText("1 of 2 left for you");

    // back to the answered crop: the second labeler and Luna are shown now
    await page.keyboard.press("ArrowLeft");
    const reveal = page.getByTestId("benchmark-reveal");
    await expect(reveal).toContainText("second-labeler");
    await expect(reveal).toContainText("luna-medium pq-v5");
    const deadMissed = page.getByTestId("benchmark-question-m1_dead_missed");
    // you said yes, the labeler no (amber: you flag it), Luna yes at 85 (green)
    await expect(deadMissed.locator(".border-amber-500")).toHaveText("No");
    await expect(deadMissed.locator(".border-green-500")).toContainText("Yes");
  });

  test("Shift+Space labels the whole crop fine and C stores can't tell", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit/benchmark/prediction_quality?filter=open");
    await expect(page.getByTestId("benchmark-crop")).toBeVisible();
    await page.keyboard.press("Shift+Space");
    await expect.poll(() => saved.length).toBe(3);
    expect(saved.every((r) => r.verdict === "ok")).toBe(true);
    await expect(page.getByTestId("benchmark-position")).toHaveText("2 / 2");
    await page.keyboard.press("c");
    await expect.poll(() => saved.length).toBe(4);
    expect(saved[3]).toMatchObject({ layer: "image", verdict: "major", modes: { m0_not_assessable: true }, crop_id: 102 });
    await expect(page.getByTestId("benchmark-left")).toContainText("0 of 2 left for you");
  });

  test("a dataset is labeled for the dataset evaluation benchmark", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/dataset-audit/benchmark/dataset_evaluation?filter=open");
    await expect(page.getByTestId("benchmark-evaluation-images").getByRole("img")).toHaveCount(3);
    await page.keyboard.press("3");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Excluding needs a reason")).toBeVisible();
    await page.keyboard.press("q");
    await page.keyboard.press("Enter");
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ check_key: "dataset_evaluation", dataset_id: 601, crop_id: null, layer: "image", verdict: "major", reason_code: "blurry", run_id: null });
    await expect(page.getByTestId("benchmark-reveal")).toContainText("Nobody else labeled this dataset yet");
  });
});
