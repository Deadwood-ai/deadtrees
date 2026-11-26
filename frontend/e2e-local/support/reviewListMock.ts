import type { Route } from "@playwright/test";

type Row = Record<string, unknown>;

/** The browser reads a count from Content-Range only when the response lets it. */
const EXPOSE_RANGE = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range" };

function matches(row: Row, column: string, filter: string): boolean {
  const [op, ...rest] = filter.split(".");
  const value = rest.join(".");
  const cell = row[column];
  if (op === "eq") return String(cell) === value;
  if (op === "lt") return Number(cell) < Number(value);
  if (op === "gt") return Number(cell) > Number(value);
  if (op === "gte") return Number(cell) >= Number(value);
  if (op === "is") return value === "null" ? cell === null || cell === undefined : String(cell) === value;
  if (op === "neq") return value === "{}" ? (cell as unknown[]).length > 0 : String(cell) !== value;
  if (op === "cs") return value.slice(1, -1).split(",").every((v) => (cell as unknown[]).includes(v));
  throw new Error(`review_list mock: no ${op}`);
}

/** The rows of a PostgREST query on audit.review_list: the filters the list uses, newest first. */
function reviewListRows(url: URL, all: Row[]): Row[] {
  let rows = all;
  for (const [key, filter] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (key === "or") {
      const parts = filter.slice(1, -1).split(",").map((part) => part.split(/\.(.*)/s));
      rows = rows.filter((row) => parts.some(([column, f]) => matches(row, column, f)));
    } else rows = rows.filter((row) => matches(row, key, filter));
  }
  return [...rows].sort((a, b) => Number(b.dataset_id) - Number(a.dataset_id));
}

/** Answers a request on audit.review_list from these rows: a page, or a count (HEAD). */
export async function fulfillReviewList(route: Route, all: Row[]) {
  const url = new URL(route.request().url());
  const rows = reviewListRows(url, all);
  if (route.request().method() === "HEAD") {
    await route.fulfill({ status: 200, headers: { "content-range": `*/${rows.length}`, ...EXPOSE_RANGE } });
    return;
  }
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const page = rows.slice(offset, offset + Number(url.searchParams.get("limit") ?? rows.length));
  await route.fulfill({
    contentType: "application/json",
    headers: { "content-range": page.length ? `${offset}-${offset + page.length - 1}/*` : "*/*", ...EXPOSE_RANGE },
    json: page,
  });
}
