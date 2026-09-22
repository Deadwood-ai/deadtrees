import { expect, test, type Page, type Route } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";

const operator = {
  id: "00000000-0000-4000-8000-0000000000c3",
  email: "operator-local-e2e@example.com",
};
const contributor = {
  id: "00000000-0000-4000-8000-0000000000b2",
  email: "reporter-local-e2e@example.com",
};

const AS_OF = "2026-01-06T09:00:00Z";

type Row = Record<string, unknown> & { dataset_id: number };

const baseRow = (id: number): Row => ({
  dataset_id: id,
  file_name: `factory-${id}.tif`,
  created_at: `2026-01-0${(id % 5) + 1}T08:00:00Z`,
  user_id: contributor.id,
  user_email: contributor.email,
  organisation: id % 2 ? "Forest Lab" : null,
  archived: false,
  state: id % 2 ? "ready" : "incomplete",
  stage: "idle",
  has_error: false,
  error_message: null,
  worker_id: null,
  claimed_at: null,
  queued_at: null,
  queue_priority: null,
  task_types: null,
  last_signal_at: "2026-01-05T08:00:00Z",
  is_ready: id % 2 === 1,
  upload_done: true,
  notification_state: id % 2 ? "sent" : "none",
  notification_problem: false,
  publication_state: "none",
  open_reports: 0,
  has_audit: id % 3 === 0,
  intent: "unknown",
});

const rows: Row[] = Array.from({ length: 60 }, (_, index) => baseRow(5001 + index));
const byId = (id: number) => rows.find((row) => row.dataset_id === id)!;

Object.assign(byId(5060), {
  attention_reason: "silent",
  attention_since: "2026-01-06T07:20:00Z",
  attention_rank: 6,
  state: "claimed",
  stage: "odm_processing",
  worker_id: "helicon",
  claimed_at: "2026-01-06T07:15:00Z",
  queued_at: "2026-01-06T07:00:00Z",
  queue_priority: 3,
  task_types: ["odm_processing", "geotiff", "cog"],
  last_signal_at: "2026-01-06T07:20:00Z",
  is_ready: false,
  notification_state: "none",
});
Object.assign(byId(5059), {
  attention_reason: "failed",
  attention_since: null,
  attention_rank: 1,
  state: "failed",
  stage: "cog",
  has_error: true,
  error_message: "COG conversion failed in local factory fixture",
  is_ready: false,
  notification_state: "failed",
  notification_problem: true,
  open_reports: 1,
});
Object.assign(byId(5058), {
  state: "queued",
  stage: "idle",
  queued_at: "2026-01-06T06:00:00Z",
  queue_priority: 2,
  task_types: ["embedding_processing"],
  is_ready: true,
});
Object.assign(byId(5057), { publication_state: "published" });
Object.assign(byId(5056), { state: "uncertain", stage: "cog", is_ready: false, attention_reason: "uncertain", attention_since: "2026-01-05T08:00:00Z", attention_rank: 2 });

const overview = {
  as_of: AS_OF,
  since: "2025-12-30T09:00:00Z",
  counts: {
    datasets: 60,
    ready: 29,
    queued: 1,
    claimed: 1,
    failed: 1,
    uncertain: 1,
    contributors_needing_attention: 1,
    new_submissions: 12,
    new_contributors: 1,
    audits_in_period: 4,
    validated_patches: 2,
    publications_in_period: 1,
    grants_in_period: 0,
    notification_problems: 1,
    publication_pending: 0,
    open_reports: 1,
  },
  workers: [
    {
      worker_id: "helicon",
      dataset_id: 5060,
      claimed_at: "2026-01-06T07:15:00Z",
      task_types: ["odm_processing", "geotiff", "cog"],
      last_signal_at: "2026-01-06T07:20:00Z",
    },
  ],
  cohorts: [
    { week: "2026-01-05", submitted: 12, ready: 6, failed: 1 },
    { week: "2025-12-29", submitted: 48, ready: 23, failed: 0 },
  ],
  coverage: [
    "Readiness is based on current stage flags, not a new completion event.",
    "Task purpose is unknown without durable provenance.",
  ],
};

const detailFor = (id: number) => {
  const row = byId(id);
  const failed = id === 5059;
  return {
    as_of: AS_OF,
    dataset: row,
    status: {
      id: 1,
      dataset_id: id,
      current_status: row.stage,
      is_upload_done: true,
      is_ortho_done: true,
      is_metadata_done: true,
      is_cog_done: !failed,
      is_thumbnail_done: !failed,
      is_deadwood_done: !failed,
      is_forest_cover_done: !failed,
      has_error: failed,
      error_message: failed ? row.error_message : null,
      error_stage: failed ? "cog" : null,
      updated_at: "2026-01-05T08:00:00Z",
    },
    queue: [],
    logs: [
      {
        id: 901,
        created_at: "2026-01-05T08:00:00Z",
        level: failed ? "ERROR" : "INFO",
        category: "processing",
        message: failed ? "COG conversion failed in local factory fixture" : "Processing finished",
      },
      { id: 900, created_at: "2026-01-05T07:59:00Z", level: "INFO", category: "processing", message: "Stage started" },
    ],
    log_total: 350,
    outputs: {
      orthos: [{ version: 1, created_at: "2026-01-05T07:00:00Z", ortho_file_size: 123456789, ortho_upload_runtime: 42.5 }],
      cogs: failed ? [] : [{ version: 1, created_at: "2026-01-05T07:30:00Z", cog_file_size: 2345678, cog_processing_runtime: 12 }],
      thumbnails: [],
      raw_images: [],
    },
    notifications: failed
      ? [
          {
            id: "n-1",
            event_type: "processing_failed",
            status: "failed",
            recipient_roles: ["owner"],
            delivery_attempts: 3,
            next_attempt_at: "2026-01-06T10:00:00Z",
            sent_at: null,
            created_at: "2026-01-05T08:01:00Z",
            delivery_error: "mail provider rejected the message",
          },
        ]
      : [],
    publications: [],
    reports: failed
      ? [{ id: 81, flag_type: "prediction", status: "open", created_at: "2026-01-05T09:00:00Z", updated_at: null, description: "Prediction looks wrong in the north", auditor_comment: null }]
      : [],
    audits: [],
    corrections: [],
    correction_total: 0,
  };
};

const activity = {
  as_of: AS_OF,
  total: 3,
  items: [
    { kind: "publications", id: "12", dataset_id: null, created_at: "2026-01-06T08:00:00Z", state: "pending", summary: "10.1000/example" },
    { kind: "processing", id: "901", dataset_id: 5059, created_at: "2026-01-05T08:00:00Z", state: "ERROR", summary: "COG conversion failed in local factory fixture" },
    { kind: "uploads", id: "5060", dataset_id: 5060, created_at: "2026-01-06T07:00:00Z", state: "upload_done", summary: "factory-5060.tif" },
  ],
};

const trendPoint = (start: string, end: string, seed: number, extra: Record<string, unknown> = {}) => ({
  start,
  end,
  partial: false,
  measured: true,
  uploaded: 10 + seed,
  first_ready: 7 + seed,
  completed_input_gib: 4.25 + seed,
  volume_samples: 6 + seed,
  lead_p50_hours: 0.75 + seed * 0.1,
  lead_p90_hours: 2.5 + seed * 0.2,
  lead_samples: 7 + seed,
  failures: 3,
  recovered: 2,
  recovery_p50_hours: 1.5,
  recovery_p90_hours: null,
  registered: 12 + seed,
  recorded_completed: 9 + seed,
  recorded_failed: 1,
  recorded_embedding_completed: 5,
  ...extra,
});

const trends = {
  as_of: AS_OF,
  tracking_since: "2025-12-29T00:00:00Z",
  interval: "week",
  workflow: "all",
  size: "all",
  summary: {
    tracked_submissions: 24,
    first_ready: 17,
    waiting: 5,
    failed: 2,
    waiting_contributors: 3,
    overdue: 1,
    oldest_wait_hours: 30.5,
    lead_p50_hours: 0.8,
    lead_p90_hours: 2.6,
    lead_samples: 17,
    recovered: 4,
    unresolved_failures: 2,
    recovery_p50_hours: 1.5,
    recovery_p90_hours: 6,
    completed_input_gib: 9.5,
    volume_samples: 15,
    missing_volume: 2,
    legacy_uploaded: 40,
  },
  series: [
    trendPoint("2025-12-22T00:00:00Z", "2025-12-29T00:00:00Z", 0, {
      measured: false,
      uploaded: null,
      first_ready: null,
      completed_input_gib: null,
      volume_samples: null,
      lead_p50_hours: null,
      lead_p90_hours: null,
      lead_samples: null,
      failures: null,
      recovered: null,
      recovery_p50_hours: null,
      recovery_p90_hours: null,
    }),
    trendPoint("2025-12-29T00:00:00Z", "2026-01-05T00:00:00Z", 1),
    trendPoint("2026-01-05T00:00:00Z", "2026-01-12T00:00:00Z", 2, { partial: true, lead_p90_hours: null, completed_input_gib: null, volume_samples: null }),
  ],
  coverage: ["Measured outcomes cover uploads completed since measurement started."],
};

const journey = {
  as_of: AS_OF,
  tracking_since: "2025-12-29T00:00:00Z",
  activation_tracking_since: "2026-01-05T00:00:00Z",
  pipeline: { uploaded: 58, queued: 1, processing: 1, ready: 29, failed: 1, audited: 20, published: 1 },
  weekly: [
    { start: "2025-12-22T00:00:00Z", end: "2025-12-29T00:00:00Z", partial: false, uploads: null, first_ready: null, observed_views: null, publications: 0 },
    { start: "2025-12-29T00:00:00Z", end: "2026-01-05T00:00:00Z", partial: false, uploads: 11, first_ready: 8, observed_views: null, publications: 1 },
    { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z", partial: true, uploads: 12, first_ready: 9, observed_views: 3, publications: 0 },
  ],
  cohorts: [
    { week: "2026-01-05", contributors: 7, activated_7d: 3, activation_eligible: 6, returned_30d: null, retention_eligible: 0 },
    { week: "2025-12-29", contributors: 6, activated_7d: null, activation_eligible: 0, returned_30d: null, retention_eligible: 0 },
    { week: "2025-12-01", contributors: 8, activated_7d: 1, activation_eligible: 8, returned_30d: 2, retention_eligible: 8 },
  ],
  coverage: ["Observed first views are consented owner visits only."],
};

const attentionRows = () =>
  rows
    .filter((row) => typeof row.attention_rank === "number")
    .sort((a, b) => Number(a.attention_rank) - Number(b.attention_rank));

const operations = () => ({
  as_of: AS_OF,
  attention_total: attentionRows().length,
  attention_contributors: 1,
  attention: attentionRows().slice(0, 10),
  waiting: [
    { key: "queued", count: 1, oldest_at: "2026-01-06T06:00:00Z", age_label: "Oldest queue entry", filters: { state: "queued" } },
    { key: "processing", count: 1, oldest_at: "2026-01-06T07:15:00Z", age_label: "Oldest claim start", filters: { state: "claimed" } },
    { key: "failed", count: 1, oldest_at: null, age_label: "Oldest known open failure", filters: { has_error: true } },
    { key: "delivery", count: 1, oldest_at: "2026-01-05T08:01:00Z", age_label: "Oldest problem notification", filters: { notification: "problem" } },
    { key: "reports", count: 1, oldest_at: "2026-01-05T09:00:00Z", age_label: "Oldest open report", filters: { reports: "open" } },
  ],
  coverage: ["Silence does not prove a stuck worker."],
});

type Options = {
  canOperate: boolean;
  historyMode?: "empty" | "malformed";
  rpcMode?: "ok" | "denied" | "failing";
  trendsMode?: "ok" | "empty" | "refetch-fails";
  journeyMode?: "ok" | "empty";
  operationsMode?: "ok" | "empty" | "refetch-fails";
  largeHistory?: boolean;
};

let operationsRequestCount = 0;

let trendsRequestCount = 0;

const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];

const applyFilters = (filters: Record<string, unknown>) =>
  rows
    .filter((row) => {
      if (filters.state && row.state !== filters.state) return false;
      if (Array.isArray(filters.ids) && !filters.ids.includes(row.dataset_id)) return false;
      if (filters.has_error !== undefined && row.has_error !== filters.has_error) return false;
      if (filters.ready !== undefined && row.is_ready !== filters.ready) return false;
      if (filters.uploaded !== undefined && row.upload_done !== filters.uploaded) return false;
      if (filters.notification === "problem" && !row.notification_problem) return false;
      if (filters.reports === "open" && !(Number(row.open_reports) > 0)) return false;
      if (filters.attention === true && typeof row.attention_rank !== "number") return false;
      if (typeof filters.search === "string" && filters.search) {
        const haystack = `${row.dataset_id} ${row.file_name} ${row.user_email} ${row.organisation ?? ""}`.toLowerCase();
        if (!haystack.includes(filters.search.toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) =>
      filters.sort === "attention"
        ? (typeof a.attention_rank === "number" ? Number(a.attention_rank) : 1e9) - (typeof b.attention_rank === "number" ? Number(b.attention_rank) : 1e9) || b.dataset_id - a.dataset_id
        : b.dataset_id - a.dataset_id,
    );

const fulfillJson = async (route: Route, json: unknown, status = 200) => {
  await route.fulfill({ status, contentType: "application/json", json });
};

const fulfillRpc = async (route: Route, name: string, options: Options) => {
  const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
  rpcCalls.push({ name, body });

  if (name.startsWith("factory_") && options.rpcMode === "denied") {
    await fulfillJson(route, { code: "42501", message: "Factory operator permission required", details: null, hint: null }, 403);
    return;
  }
  if (name.startsWith("factory_") && options.rpcMode === "failing") {
    await fulfillJson(route, { code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null }, 500);
    return;
  }

  if (name === "factory_overview") {
    await fulfillJson(route, overview);
    return;
  }
  if (name === "factory_operations") {
    operationsRequestCount += 1;
    if (options.operationsMode === "refetch-fails" && operationsRequestCount > 1) {
      await fulfillJson(route, { code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null }, 500);
      return;
    }
    await fulfillJson(route, options.operationsMode === "empty" ? { ...operations(), attention_total: 0, attention_contributors: 0, attention: [], waiting: [] } : operations());
    return;
  }
  if (name === "factory_history") {
    if (options.historyMode === "malformed") { await fulfillJson(route, {}); return; }
    await fulfillJson(route, {
      as_of: AS_OF, first_registration: "2010-01-01T00:00:00Z", year: body.p_year,
      years: [2026, 2010], upload_since: "2010-03-01T00:00:00Z", run_since: "2010-04-01T00:00:00Z",
      coverage: { datasets: 60, ready_now: 25, upload_evidence: 40, upload_sizes: 39, timing_pairs: 20, measured_uploads: 3 },
      series: options.historyMode === "empty" ? [] : [{ start: "2010-01-01T00:00:00Z", end: "2011-01-01T00:00:00Z", partial: false,
        registered: 12, uploaded: 10, completed: 9, failed: 2, indexing: 4, emails: 18, reports: 2,
        publications: 1, input_gib: 1.5, size_samples: 9, contributors: 3, returning_contributors: 1,
        p50: 24, p90: 48, timing_samples: 8 }],
    });
    return;
  }
  if (name === "factory_journey") {
    await fulfillJson(
      route,
      options.journeyMode === "empty"
        ? { ...journey, pipeline: null, weekly: [], cohorts: [], tracking_since: null, activation_tracking_since: null, coverage: [] }
        : journey,
    );
    return;
  }
  if (name === "factory_trends") {
    trendsRequestCount += 1;
    if (options.trendsMode === "refetch-fails" && trendsRequestCount > 1) {
      await fulfillJson(route, { code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null }, 500);
      return;
    }
    await fulfillJson(
      route,
      options.trendsMode === "empty"
        ? { ...trends, series: [], summary: null, tracking_since: null }
        : { ...trends, interval: body.p_interval ?? "week", workflow: body.p_workflow ?? "all", size: body.p_size ?? "all" },
    );
    return;
  }
  if (name === "factory_datasets") {
    const filters = (body.p_filters ?? {}) as Record<string, unknown>;
    const limit = Number(body.p_limit ?? 50);
    const offset = Number(body.p_offset ?? 0);
    const filtered = applyFilters(filters);
    await fulfillJson(route, { as_of: AS_OF, total: filtered.length, items: filtered.slice(offset, offset + limit) });
    return;
  }
  if (name === "factory_dataset") {
    const id = Number(body.p_dataset_id);
    const detail = detailFor(id);
    await fulfillJson(route, !rows.some((row) => row.dataset_id === id) ? { as_of: AS_OF, dataset: null } : options.largeHistory ? {
      ...detail,
      record_totals: { notifications: 205 },
      notifications: Array.from({ length: 200 }, (_, index) => ({ ...detail.notifications[0], id: `history-${index}` })),
    } : detail);
    return;
  }
  if (name === "factory_activity") {
    const kind = String(body.p_kind ?? "all");
    const items = kind === "all" ? activity.items : activity.items.filter((item) => item.kind === kind);
    await fulfillJson(route, { as_of: AS_OF, total: items.length, items });
    return;
  }
  await fulfillJson(route, []);
};

const installOperator = async (page: Page, options: Options) => {
  rpcCalls.length = 0;
  trendsRequestCount = 0;
  operationsRequestCount = 0;
  await installLocalSession(page, {
    user: operator,
    supabaseUrl: localSupabaseUrl,
    refreshToken: "local-operator-e2e-refresh-token",
  });
  await page.addInitScript(() => {
    (window as unknown as { __factoryCopied: string[] }).__factoryCopied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __factoryCopied: string[] }).__factoryCopied.push(text);
        },
      },
    });
  });

  await page.route(`${localSupabaseUrl}/rest/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/").filter(Boolean);
    const resource = segments.at(-1) ?? "";
    if (segments.at(-2) === "rpc") {
      await fulfillRpc(route, resource, options);
      return;
    }
    if (resource === "privileged_users") {
      await fulfillJson(route, {
        id: 1,
        user_id: operator.id,
        can_upload_private: false,
        can_audit: false,
        can_view_all_private: false,
        can_operate: options.canOperate,
        created_at: "2026-01-01T00:00:00Z",
      });
      return;
    }
    const wantsObject = route.request().headers()["accept"]?.includes("vnd.pgrst.object") ?? false;
    await fulfillJson(route, wantsObject ? null : []);
  });
};

const dismissCookieBanner = async (page: Page) => {
  await page.getByRole("button", { name: "Accept" }).click({ timeout: 2_000 }).catch(() => undefined);
};

const copiedTexts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __factoryCopied: string[] }).__factoryCopied);

test.describe("factory local e2e", () => {
  test("users without the operator privilege are denied and see no Factory entry", async ({ page }) => {
    await installOperator(page, { canOperate: false });

    await page.goto("/factory");
    await dismissCookieBanner(page);

    await expect(page.getByText("Operator access required")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Factory" })).toHaveCount(0);
    await expect(page.getByTestId("factory-overview")).toHaveCount(0);
    expect(rpcCalls.filter((call) => call.name.startsWith("factory_"))).toHaveLength(0);
  });

  test("operator overview shows freshness, workers and drills into the exact filtered list", async ({ page }) => {
    await installOperator(page, { canOperate: true });

    await page.goto("/factory");
    await dismissCookieBanner(page);

    await expect(page.getByRole("menuitem", { name: "Factory" })).toBeVisible();
    await expect(page.getByTestId("factory-freshness").first()).toContainText("2026-01-06 09:00 UTC");
    const workers = page.getByTestId("factory-workers");
    await expect(workers.getByText("helicon")).toBeVisible();
    await expect(workers.getByRole("link", { name: "#5060" })).toBeVisible();
    await expect(page.getByTestId("tile-failed")).toHaveCount(0);
    await expect(page.getByTestId("factory-cohorts")).toHaveCount(0);

    const outcomes = page.getByTestId("factory-outcomes-results");
    await expect(outcomes).toContainText("Measured since 2025-12-29 00:00 UTC");
    await expect(outcomes).toContainText("40 older uploads predate measurement");
    const trendsCall = rpcCalls.find((call) => call.name === "factory_trends");
    expect(trendsCall?.body).toEqual({ p_interval: "week", p_workflow: "all", p_size: "all" });
    const summary = page.getByTestId("factory-measured-summary");
    await expect(summary).toContainText("Still waiting");
    await expect(summary.getByRole("link", { name: "5" })).toHaveAttribute("href", "/factory/datasets?archived=all&metric=waiting");
    await expect(summary).toContainText("3 pending");
    await expect(summary.getByRole("link", { name: "2 failed" })).toHaveAttribute("href", "/factory/datasets?archived=all&metric=failed_submission");
    await expect(summary).toContainText("1 d 6 h");
    await expect(summary.getByRole("link", { name: "1 overdue" })).toHaveAttribute("href", "/factory/datasets?archived=all&metric=overdue");
    await expect(page.getByTestId("factory-outcomes-timing")).toContainText("All tracked completions: p50 48 min · p90 2 h 36 min · n 17");
    await expect(page.getByTestId("factory-outcomes-failures")).toContainText("Unresolved now: 2");

    const attention = page.getByTestId("factory-attention");
    await expect(attention.getByTestId("factory-attention-summary")).toContainText("3 datasets across 1 contributor");
    await expect(attention.getByTestId("factory-attention-all")).toHaveAttribute("href", "/factory/datasets?attention=true&sort=attention");
    const attentionRowsOnPage = attention.locator("tr.ant-table-row");
    await expect(attentionRowsOnPage).toHaveCount(3);
    await expect(attentionRowsOnPage.nth(2).locator("td").first()).toHaveText("3");
    await expect(attentionRowsOnPage.nth(0)).toContainText("#5059");
    await expect(attentionRowsOnPage.nth(0).getByTestId("attention-reason")).toHaveText("Failed");
    await expect(attentionRowsOnPage.nth(0)).toContainText("unknown");
    await expect(attentionRowsOnPage.nth(0)).toContainText("failed since");
    await expect(attentionRowsOnPage.nth(1)).toContainText("#5056");
    await expect(attentionRowsOnPage.nth(1)).toContainText("status updated");
    await expect(attentionRowsOnPage.nth(2).getByTestId("attention-reason")).toHaveText("Silent claim");
    expect(await attention.evaluate((node) => node.getBoundingClientRect().top)).toBeLessThan(
      await page.getByTestId("factory-waiting").evaluate((node) => node.getBoundingClientRect().top),
    );

    const waiting = page.getByTestId("factory-waiting");
    await expect(waiting.getByTestId("waiting-queued")).toHaveAttribute("href", "/factory/datasets?state=queued&sort=attention");
    await expect(waiting.getByTestId("waiting-queued")).toContainText("Oldest queue entry");
    await expect(waiting.getByTestId("waiting-failed")).toHaveAttribute("href", "/factory/datasets?has_error=true&sort=attention");
    await expect(waiting.getByTestId("waiting-failed")).toContainText("unknown");
    await expect(waiting.getByTestId("waiting-delivery")).toContainText("oldest");
    await expect(waiting.getByTestId("waiting-reports")).toHaveAttribute("href", "/factory/datasets?reports=open&sort=attention");
    await expect(page.getByTestId("factory-workers")).toContainText("Running now");
    await expect(page.getByTestId("factory-overview")).not.toContainText("Acquisition");
    await expect(page.getByTestId("factory-history")).toHaveCount(0);
    expect(rpcCalls.filter((call) => call.name === "factory_journey")).toHaveLength(0);

    await page.getByText("History and outcomes after the result").click();
    await expect(page).toHaveURL(/history=open/);
    const after = page.getByTestId("factory-journey-outcomes");
    await expect(after).toContainText("lower bound");
    await expect(after.getByTestId("trend-bucket-2025-12-29T00:00:00Z")).toHaveAttribute("aria-label", /Observed first views \(lower bound\) unknown/);
    const cohorts = after.getByTestId("factory-journey-cohorts");
    await expect(cohorts.locator("tr").filter({ hasText: "2026-01-05" })).toContainText("3 of 6 (50%)");
    await expect(after).not.toContainText("Referral");
    expect(rpcCalls.filter((call) => call.name === "factory_journey")).toHaveLength(1);

    await page.getByText("What these numbers cannot tell you").click();
    for (const line of overview.coverage) await expect(page.getByTestId("factory-coverage")).toContainText(line);
    await expect(page.getByTestId("factory-coverage")).toContainText("Silence does not prove a stuck worker.");
    await expect(page.getByTestId("factory-coverage")).toContainText("Observed first views are consented owner visits only.");

    await waiting.getByTestId("waiting-queued").click();
    await expect(page).toHaveURL(/\/factory\/datasets\?state=queued&sort=attention$/);
    await expect(page.getByTestId("factory-order-label")).toHaveText("needs attention first (server ranked)");
    const queuedRow = page.locator("tr.ant-table-row").filter({ hasText: "#5058" });
    await expect(queuedRow.getByTestId("factory-state")).toHaveText("Queued");
    const queuedCall = rpcCalls.filter((call) => call.name === "factory_datasets").at(-1);
    expect(queuedCall?.body.p_filters).toEqual({ state: "queued", sort: "attention" });
    await expect(page.getByTestId("factory-datasets").locator("th", { hasText: "Reason" }).first()).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("factory-attention")).toBeVisible();

    await page.getByTestId("factory-attention").getByRole("link", { name: "#5059" }).click();
    await expect(page.getByRole("heading", { name: "Dataset #5059" })).toBeVisible();
    await expect(page.getByTestId("factory-detail-back")).toHaveText("← Back to overview");
    await expect(page.getByTestId("factory-detail-back")).toHaveAttribute("href", "/factory");
    await page.getByTestId("factory-detail-back").click();
    await expect(page.getByTestId("factory-attention")).toBeVisible();
    await expect(page.getByTestId("factory-workers").getByTestId("factory-freshness")).toContainText("2026-01-06 09:00 UTC");
    await expect(page.getByTestId("factory-outcomes-timing")).toContainText("still need calibration");
    await expect(page.getByTestId("factory-outcomes-timing").locator("svg")).not.toContainText("1 h target");
    await page.getByTestId("factory-outcomes-failures").locator(".ant-segmented-item-label", { hasText: "Recovery time" }).click();
    await expect(page.getByTestId("factory-outcomes-failures")).toContainText("n recovered episodes");
    await expect(page.getByTestId("factory-outcomes-failures")).toContainText("Unresolved now: 2");
    await page.getByTestId("factory-outcomes-failures").locator(".ant-segmented-item-label", { hasText: "Counts" }).click();
    await page.screenshot({ path: process.env.FACTORY_SHOT_DIR ? `${process.env.FACTORY_SHOT_DIR}/overview-desktop.png` : "test-results/overview-desktop.png", fullPage: true });

    await outcomes.getByTestId("trend-bucket-2025-12-29T00:00:00Z").click();
    await expect(page).toHaveURL(/bucket=2025-12-29T00%3A00%3A00Z/);
    const panel = page.getByTestId("factory-selected-bucket");
    await expect(panel).toContainText("Selected week: 2025-12-29 00:00 UTC to 2026-01-05 00:00 UTC");
    await expect(panel).toContainText("Uploads completed 11");
    await expect(panel).toContainText("Upload to result p50 51 min · p90 2 h 42 min · n 8");
    await expect(panel.getByRole("link", { name: "8", exact: true })).toHaveAttribute(
      "href",
      "/factory/datasets?archived=all&metric=first_ready&metric_after=2025-12-29T00%3A00%3A00Z&metric_before=2026-01-05T00%3A00%3A00Z",
    );

    await outcomes.getByTestId("trend-bucket-2025-12-22T00:00:00Z").click();
    await expect(page.getByTestId("factory-selected-bucket")).toContainText("before measurement");
    await outcomes.getByTestId("trend-bucket-2026-01-05T00:00:00Z").click();
    await expect(page.getByTestId("factory-selected-bucket")).toContainText("partial period");
    await outcomes.getByTestId("trend-bucket-2025-12-22T00:00:00Z").click();
    await expect(page.getByTestId("factory-selected-bucket")).toContainText("Uploads completed unknown");
    await expect(page.getByTestId("factory-selected-bucket")).toContainText("Registered datasets 12");

    await page.getByTestId("factory-trend-controls").locator(".ant-segmented-item-label", { hasText: "Days" }).click();
    await expect(page).toHaveURL(/interval=day/);
    await expect.poll(() => rpcCalls.filter((call) => call.name === "factory_trends").at(-1)?.body).toEqual({ p_interval: "day", p_workflow: "all", p_size: "all" });

    await page.getByTestId("factory-trend-controls").locator(".ant-select").first().click();
    await page.locator(".ant-select-dropdown").getByTitle("GeoTIFF uploads").click();
    await expect(page).toHaveURL(/workflow=geotiff/);
    await expect.poll(() => rpcCalls.filter((call) => call.name === "factory_trends").at(-1)?.body).toEqual({ p_interval: "day", p_workflow: "geotiff", p_size: "all" });
    await page.getByTestId("factory-trend-controls").locator(".ant-select").nth(1).click();
    await page.locator(".ant-select-dropdown:visible").getByTitle("Under 1 GiB").click();
    await expect(page).toHaveURL(/size=small/);
    await expect(page.getByTestId("factory-outcomes-timing").locator("svg")).toContainText("1 h target");
    await page.getByTestId("factory-trend-controls").locator(".ant-select").nth(1).click();
    await page.locator(".ant-select-dropdown:visible").getByTitle("All sizes").click();
    await expect(page).not.toHaveURL(/size=small/);
    const sizeCall = rpcCalls.find((call) => call.name === "factory_trends" && call.body.p_size === "small");
    expect(sizeCall?.body).toEqual({ p_interval: "day", p_workflow: "geotiff", p_size: "small" });
    await page.getByTestId("factory-measured-summary").getByRole("link", { name: "5" }).click();
    await expect(page).toHaveURL(/\/factory\/datasets\?archived=all&metric=waiting&workflow=geotiff$/);
    await expect(page.getByTestId("factory-ledger-chips")).toContainText("Ledger: still waiting");
    await expect(page.getByTestId("factory-ledger-chips")).toContainText("Workflow: GeoTIFF uploads");
    const drillCall = rpcCalls.filter((call) => call.name === "factory_datasets").at(-1);
    expect(drillCall?.body.p_filters).toEqual({ archived: "all", metric: "waiting", workflow: "geotiff" });
  });

  test("explorer keeps selection across pages and copies a factual snapshot", async ({ page }) => {
    await installOperator(page, { canOperate: true });

    await page.goto("/factory/datasets");
    await dismissCookieBanner(page);
    await expect(page.getByTestId("factory-datasets-total")).toContainText("60 datasets match");

    const rowsOnPage = page.getByTestId("factory-datasets").locator("tr.ant-table-row");
    await rowsOnPage.nth(0).getByRole("checkbox").check();
    await rowsOnPage.nth(1).getByRole("checkbox").check();
    await expect(page.getByTestId("factory-selection-tray")).toContainText("2 selected");

    await page.getByRole("listitem", { name: "2" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(rowsOnPage.first()).toContainText("#5010");
    await rowsOnPage.nth(0).getByRole("checkbox").check();
    await expect(page.getByTestId("factory-selection-tray")).toContainText("3 selected");

    await page.getByTestId("factory-sort").locator(".ant-segmented-item-label", { hasText: "Needs attention first" }).click();
    await expect(page).toHaveURL(/sort=attention/);
    await expect(page.getByTestId("factory-order-label")).toHaveText("needs attention first (server ranked)");
    const sortedCall = rpcCalls.filter((call) => call.name === "factory_datasets").at(-1);
    expect(sortedCall?.body.p_filters).toEqual({ sort: "attention" });
    await expect(rowsOnPage.first()).toContainText("#5059");
    await expect(rowsOnPage.first().getByTestId("attention-reason")).toHaveText("Failed");
    await expect(page.getByTestId("factory-selection-tray")).toContainText("3 selected");
    await page.getByTestId("factory-sort").locator(".ant-segmented-item-label", { hasText: "Newest first" }).click();
    await expect(page.getByTestId("factory-order-label")).toHaveText("newest first");

    await page.getByRole("button", { name: "Copy IDs" }).click();
    expect(await copiedTexts(page)).toEqual(["5060, 5059, 5010"]);

    await page.getByRole("button", { name: "Copy context" }).click();
    const snapshot = page.getByTestId("factory-snapshot-text");
    await expect(snapshot).toBeVisible();
    const text = await snapshot.inputValue();
    expect(text).toContain("Factory snapshot, read-only facts, taken 2026-01-06 09:00 UTC");
    expect(text).toContain("requests no action");
    expect(text).toContain("#5060 · factory-5060.tif");
    expect(text).toContain("#5059 · factory-5059.tif");
    expect(text).toContain("#5010 · factory-5010.tif");
    expect(text).toContain("/factory/datasets/5059");
    expect(text).toContain("worker: helicon");
    expect(text).toContain("attention: Failed · failed since: unknown");
    expect(text).toContain("attention: Silent claim · last DB signal: 2026-01-06 07:20 UTC");
    expect(text).not.toMatch(/\bretry\b/i);
    const snapshotCall = rpcCalls.filter((call) => call.name === "factory_datasets").at(-1);
    expect(snapshotCall?.body.p_filters).toEqual({ ids: [5060, 5059, 5010], archived: "all" });

    await page.getByRole("button", { name: "Copy to clipboard" }).click();
    expect((await copiedTexts(page)).at(-1)).toBe(text);

    await page.locator(".ant-modal-footer").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByTestId("factory-selection-tray")).toHaveCount(0);
  });

  test("returning from detail preserves the filtered page and both scroll positions", async ({ page }) => {
    await installOperator(page, { canOperate: true });
    await page.goto("/factory/datasets?search=factory&page=2");
    await dismissCookieBanner(page);
    const dataset = page.getByRole("link", { name: "#5003", exact: true });
    await dataset.scrollIntoViewIfNeeded();
    const table = page.getByTestId("factory-datasets").locator(".ant-table-content");
    await table.evaluate((element) => { element.scrollLeft = 250; });
    const top = await page.evaluate(() => window.scrollY);
    expect(top).toBeGreaterThan(200);

    for (const browserBack of [false, true]) {
      await dataset.click();
      await expect(page.getByTestId("factory-detail-header")).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      if (browserBack) await page.goBack();
      else await page.getByRole("link", { name: "Back to datasets" }).click();
      await expect(page).toHaveURL(/search=factory&page=2$/);
      await expect(dataset).toBeInViewport();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(top, 0);
      await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBe(250);
    }
  });

  test("large histories disclose their bounded window and full count", async ({ page }) => {
    await installOperator(page, { canOperate: true, largeHistory: true });
    await page.goto("/factory/datasets/5059");
    await dismissCookieBanner(page);
    await expect(page.getByTestId("factory-history-limit")).toContainText("notifications: 200 of 205");
    await expect(page.getByTestId("factory-detail-notifications").getByText("205", { exact: true })).toBeVisible();
  });

  test("detail heading and actions stay inside the card on desktop and phone", async ({ page }) => {
    await installOperator(page, { canOperate: true });
    await page.goto("/factory/datasets/5059");
    await dismissCookieBanner(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const card = page.getByTestId("factory-detail-header");
      await expect(card).toBeVisible();
      const bounds = await card.boundingBox();
      for (const element of [card.getByRole("heading"), card.getByRole("button", { name: "Add to selection" })]) {
        const child = await element.boundingBox();
        expect(child!.y - bounds!.y).toBeGreaterThanOrEqual(20);
        expect(child!.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(child!.x + child!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      }
    }
  });

  test("dataset detail shows process evidence with honest empty states", async ({ page }) => {
    await installOperator(page, { canOperate: true });

    await page.goto("/factory/datasets/5059");
    await dismissCookieBanner(page);

    await expect(page.getByRole("heading", { name: "Dataset #5059" })).toBeVisible();
    await expect(page.getByTestId("factory-detail-error")).toContainText("COG conversion failed in local factory fixture");
    await expect(page.getByTestId("factory-detail-status")).toContainText("Map image");
    await expect(page.getByTestId("factory-detail-queue")).toContainText("No queue row now");
    await expect(page.getByTestId("factory-detail-logs")).toContainText("Showing the newest 2 of 350");
    await expect(page.getByTestId("factory-detail-logs")).toContainText("Stage started");
    await expect(page.getByTestId("factory-detail-notifications")).toContainText("mail provider rejected the message");
    await expect(page.getByTestId("factory-detail-notifications")).toContainText("processing failed");
    await expect(page.getByTestId("factory-detail-publications")).toContainText("No publication record links to this dataset.");
    await expect(page.getByTestId("factory-detail-reports")).toContainText("Prediction looks wrong in the north");
    await expect(page.getByTestId("factory-detail-outputs")).toContainText("No map image record.");
    await expect(page.getByTestId("factory-detail-audits")).toContainText("No audit record");

    await page.getByTestId("factory-detail-select").click();
    await expect(page.getByTestId("factory-selection-tray")).toContainText("1 selected");
    await expect(page.getByTestId("factory-detail-select")).toHaveText("Remove from selection");
  });

  test("activity lists records including publications without a dataset", async ({ page }) => {
    await installOperator(page, { canOperate: true });

    await page.goto("/factory/activity");
    await dismissCookieBanner(page);

    const activityTable = page.getByTestId("factory-activity");
    await expect(activityTable.getByText("publication 12")).toBeVisible();
    await expect(activityTable.getByRole("link", { name: "#5059" })).toBeVisible();

    await page.getByTestId("factory-activity").locator(".ant-segmented-item-label", { hasText: "Publications" }).click();
    await expect(page).toHaveURL(/kind=publications/);
    await expect(activityTable.getByRole("link", { name: "#5059" })).toHaveCount(0);
    await expect(activityTable.getByText("10.1000/example")).toBeVisible();
  });

  test("overview without measured outcomes says so instead of showing zeros", async ({ page }) => {
    await installOperator(page, { canOperate: true, trendsMode: "empty" });

    await page.goto("/factory");
    await dismissCookieBanner(page);

    await expect(page.getByTestId("factory-outcomes")).toContainText("Measurement has not started yet");
    await expect(page.getByTestId("factory-outcomes")).toContainText("The ledger returned no summary.");
    await expect(page.getByTestId("factory-outcomes")).toContainText("No intervals were returned.");
    await expect(page.getByTestId("factory-measured-summary")).toHaveCount(0);
    await page.getByText("History and outcomes after the result").click();
    await expect(page.getByTestId("factory-historical-activity")).toContainText("Historical evidence has uneven coverage");
  });

  test("journey without data says so instead of showing zeros", async ({ page }) => {
    await installOperator(page, { canOperate: true, journeyMode: "empty" });

    await page.goto("/factory");
    await dismissCookieBanner(page);

    await page.getByText("History and outcomes after the result").click();
    await expect(page.getByTestId("factory-journey-outcomes")).toContainText("No weekly journey rows were returned.");
    await expect(page.getByTestId("factory-journey-outcomes")).toContainText("No contributor cohorts yet.");
    await expect(page.getByTestId("factory-journey-outcomes")).toContainText("from an unknown date");
  });

  test("overview without attention items says so and keeps waiting counts honest", async ({ page }) => {
    await installOperator(page, { canOperate: true, operationsMode: "empty" });

    await page.goto("/factory");
    await dismissCookieBanner(page);

    await expect(page.getByTestId("factory-attention")).toContainText("Nothing needs attention right now");
    await expect(page.getByTestId("factory-waiting")).toContainText("returned no waiting groups");
  });

  test("attention list survives a failed refresh with a stale warning", async ({ page }) => {
    await installOperator(page, { canOperate: true, operationsMode: "refetch-fails" });

    await page.goto("/factory");
    await dismissCookieBanner(page);
    await expect(page.getByTestId("factory-attention-summary")).toContainText("3 datasets");
    await page.getByTestId("factory-overview").getByRole("button", { name: "Refresh" }).first().click();
    await expect(page.getByTestId("factory-operations-stale")).toBeVisible();
    await expect(page.getByTestId("factory-attention-summary")).toContainText("3 datasets");
  });

  test("trend charts survive a failed refresh with a stale warning", async ({ page }) => {
    await installOperator(page, { canOperate: true, trendsMode: "refetch-fails" });

    await page.goto("/factory");
    await dismissCookieBanner(page);
    await expect(page.getByTestId("factory-trend-freshness")).toContainText("2026-01-06 09:00 UTC");
    await expect(page.getByTestId("factory-trend-stale")).toHaveCount(0);

    await page.getByTestId("factory-trend-freshness").getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByTestId("factory-trend-stale")).toBeVisible();
    await expect(page.getByTestId("factory-outcomes-results")).toContainText("Tracked uploads");
  });

  test("overview reads well on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installOperator(page, { canOperate: true });

    await page.goto("/factory");
    await dismissCookieBanner(page);

    await expect(page.getByTestId("factory-attention")).toBeVisible();
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ path: process.env.FACTORY_SHOT_DIR ? `${process.env.FACTORY_SHOT_DIR}/overview-phone.png` : "test-results/overview-phone.png", fullPage: true });
  });

  test("read-model errors show a retry, and permission errors show the denial state", async ({ page }) => {
    await installOperator(page, { canOperate: true, rpcMode: "failing" });
    await page.goto("/factory");
    await dismissCookieBanner(page);
    await expect(page.getByText("Could not load the attention list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" }).first()).toBeVisible();
    await expect(page.getByText("Could not load running claims")).toBeVisible();

    await installOperator(page, { canOperate: true, rpcMode: "denied" });
    await page.goto("/factory/datasets");
    await expect(page.getByText("Operator access required")).toBeVisible();
  });
});

test("historical coverage, year selection and evidence drilldown", async ({ page }) => {
  await installOperator(page, { canOperate: true });
  await page.goto("/factory");
  await dismissCookieBanner(page);
  const history = page.getByTestId("factory-historical-activity");
  await expect(history.getByTestId("factory-history-coverage")).toContainText("40 / 60");
  await expect(history).toContainText("may describe a rerun");
  await history.getByRole("combobox", { name: "Historical year" }).press("Enter");
  await page.getByText("2010 · by month", { exact: true }).click();
  await expect.poll(() => rpcCalls.filter((call) => call.name === "factory_history").at(-1)?.body).toEqual({ p_year: 2010 });
  await expect(page).toHaveURL(/history_year=2010/);
  const upload = history.getByTestId("factory-history-table").getByRole("link", { name: "10", exact: true });
  await expect(upload).toHaveAttribute("href", /metric=historical_uploaded/);
  await upload.click();
  await expect(page).toHaveURL(/metric=historical_uploaded/);
  await expect(page.getByTestId("factory-datasets")).toContainText("uploads with historical evidence");
  await page.goBack();
  await expect(page).toHaveURL(/history_year=2010/);
});

for (const mode of ["empty", "malformed"] as const) {
  test(`historical response ${mode} stays contained`, async ({ page }) => {
    await installOperator(page, { canOperate: true, historyMode: mode });
    await page.goto("/factory");
    await dismissCookieBanner(page);
    const history = page.getByTestId("factory-historical-activity");
    await expect(history).toContainText(mode === "empty" ? "No historical intervals were returned." : "Historical activity returned an incomplete response.");
    await expect(page.getByTestId("factory-attention")).toBeVisible();
  });
}
