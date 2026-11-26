import { expect, test, type Page } from "@playwright/test";
import { installLocalSession } from "./support/localAuth";

const supabaseUrl = process.env.SUPABASE_URL;
if (
  !supabaseUrl ||
  !["127.0.0.1", "localhost"].includes(new URL(supabaseUrl).hostname)
) {
  throw new Error(
    "Source the isolated worktree environment before status E2E tests.",
  );
}
const owner = {
  id: "00000000-0000-4000-8000-00000000a001",
  email: "status-local@example.invalid",
};
const ready = {
  id: 77,
  user_id: owner.id,
  file_name: "Forest survey.tif",
  authors: ["Local contributor"],
  created_at: "2026-09-01T12:00:00Z",
  data_access: "private",
  archived: false,
  current_status: "idle",
  has_error: false,
  is_upload_done: true,
  is_ortho_done: true,
  is_metadata_done: true,
  is_cog_done: true,
  is_thumbnail_done: true,
  is_deadwood_done: true,
  is_forest_cover_done: true,
  audit_decision: "keep",
  cog_path: "qa/forest.tif",
  aquisition_year: 2024,
  aquisition_month: 6,
  aquisition_day: 12,
  phenology_probability: 0.82,
};
// public.get_dataset_audit_summary of a dataset the checks are done on
const finishedAudit = {
  review_required: [],
  evaluation_decision: "keep",
  georef_status: "estimated",
  georef_offset_m: 2.6,
  date_replace: true,
  date_new: "2024-07-02",
  deadwood_total: 16,
  deadwood_major: 1,
  deadwood_minor: 3,
  deadwood_reasoning: [
    { verdict: "major", summary: "Shadows under the canopy are marked as deadwood.", errors: [] },
  ],
  forest_cover_total: 16,
  forest_cover_major: 0,
  forest_cover_minor: 2,
  forest_cover_reasoning: [
    { verdict: "minor", summary: "A small clearing is counted as tree cover.", errors: [] },
  ],
};
const dateEstimate = {
  dataset_id: 77,
  model_version: "doy-local",
  model_type: "s2",
  suggestion_reason: "mismatch",
};
const phenologyCurve = Array.from({ length: 366 }, (_, day) =>
  Math.round(255 * Math.max(0, Math.sin(((day - 80) / 366) * 2 * Math.PI))),
);
const details = (page: Page) =>
  page.getByRole("button", { name: "View status details for dataset 77" });

interface StatusMocks {
  queueFails?: boolean;
  /** the audit summary RPC's answer; null before any check ran */
  audit?: Record<string, unknown> | null;
}

async function installStatus(
  page: Page,
  changes: Record<string, unknown> = {},
  { queueFails = false, audit = finishedAudit }: StatusMocks = {},
) {
  const dataset = { ...ready, ...changes };
  await installLocalSession(page, {
    user: owner,
    supabaseUrl: supabaseUrl!,
    refreshToken: "status-test",
    acceptCookies: true,
  });
  await page.route(`${supabaseUrl}/rest/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/").pop();
    const wantsObject =
      route.request().headers()["accept"]?.includes("vnd.pgrst.object") ?? false;
    if (table === "v2_full_dataset_view_owner") {
      const json = url.searchParams.has("id")
        ? dataset
        : dataset.archived
          ? []
          : [dataset];
      await route.fulfill({ json });
      return;
    }
    if (table === "get_dataset_audit_summary") {
      await route.fulfill({ json: audit });
      return;
    }
    if (table === "v2_metadata") {
      const row = {
        metadata: {
          phenology: { phenology_curve: phenologyCurve, source: "local", version: "1" },
        },
      };
      await route.fulfill({ json: wantsObject ? row : [row] });
      return;
    }
    if (table === "v2_acquisition_date_estimates") {
      const estimate = audit?.date_replace ? dateEstimate : null;
      await route.fulfill({ json: wantsObject ? estimate : estimate ? [estimate] : [] });
      return;
    }
    if (table === "v2_queue_positions" && queueFails) {
      await route.fulfill({
        status: 503,
        json: { message: "Local queue unavailable" },
      });
      return;
    }
    if (table === "privileged_users") {
      await route.fulfill({
        json: { can_upload_private: true, can_audit: false },
      });
      return;
    }
    await route.fulfill({ json: [], headers: { "content-range": "0-0/0" } });
  });
}

test("desktop shows a stopped run with its map and the image check side by side", async ({
  page,
}) => {
  await installStatus(page, {
    has_error: true,
    error_stage: "deadwood_treecover_combined_segmentation",
    audit_decision: "keep",
  });
  await page.goto("/profile");
  await expect(
    page.getByRole("columnheader", { name: "Status", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("dataset-processing-77")).toContainText(
    "Stopped · map available",
  );
  await expect(page.getByTestId("dataset-image-check-77")).toContainText(
    "Image accepted",
  );
  await expect(
    page.getByRole("button", { name: "View map for dataset 77" }),
  ).toBeVisible();
  await expect(details(page)).toHaveText("Check details");
  await details(page).click();
  await expect(page).toHaveURL(/dataset=77/);
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText(
    "Processing stopped during combined AI analysis.",
  );
  // the audit never hides a prediction
  await expect(drawer).not.toContainText("hidden from the public map");
  await expect(
    drawer.getByRole("button", { name: "View map", exact: true }),
  ).toBeVisible();
  await expect(drawer.getByTestId("dataset-image-quality")).toHaveText("Accepted");
  await expect(drawer).not.toContainText(/retry/i);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
});

test("desktop tells a contributor when no map exists after an early failure", async ({
  page,
}) => {
  await installStatus(page, {
    has_error: true,
    error_stage: "cog_processing",
    is_cog_done: false,
    cog_path: null,
    thumbnail_path: null,
    has_deadwood_prediction: false,
    has_forest_cover_prediction: false,
    audit_decision: null,
  });
  await page.goto("/profile");
  await expect(page.getByTestId("dataset-processing-77")).toContainText(
    "Processing failed",
  );
  // no map image, so nothing was checked and nothing is promised
  await expect(page.getByTestId("dataset-image-check-77")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "View map for dataset 77" }),
  ).toHaveCount(0);
  await expect(page.getByText("No map", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Map", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Actions/ })).toBeVisible();
  await details(page).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("No map image is available.");
  await expect(drawer.getByRole("region", { name: "Data quality" })).toHaveCount(0);
  await expect(drawer).toContainText("include dataset 77");
});

test("tablet width keeps the file name and status visible without body scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await installStatus(page);
  await page.goto("/profile");
  const fileCell = page
    .getByRole("row", { name: /Forest survey\.tif/ })
    .getByRole("cell", { name: /Forest survey\.tif/ });
  await expect(fileCell).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByTestId("dataset-status-77")).toBeInViewport({
    ratio: 0.9,
  });
  // Pinned columns must not cover the file name: the elements under the cell's
  // left edge, centre and right edge all have to belong to the cell itself.
  const uncovered = (cell: HTMLElement) => {
    const rect = cell.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    return [rect.left + 4, rect.left + rect.width / 2, rect.right - 4].every((x) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && cell.contains(hit);
    });
  };
  expect(await fileCell.evaluate(uncovered)).toBe(true);
  expect(await page.getByTestId("dataset-status-77").evaluate(uncovered)).toBe(true);
  await expect(
    page.getByRole("button", { name: "View map for dataset 77" }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // Below lg only the pinned essentials render, so nothing peeks out between them.
  await expect(page.getByRole("columnheader", { name: "ID" })).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Publication" }),
  ).toHaveCount(0);
  // The account header stacks at tablet width so the email is not broken mid-word.
  const email = page.getByText(owner.email, { exact: true });
  const emailBox = await email.boundingBox();
  expect(emailBox?.height).toBeLessThan(40);
});

test("the floating header sits on an opaque band so scrolled rows do not show around it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installStatus(page);
  await page.goto("/profile");
  await expect(page.getByRole("list", { name: "My datasets" })).toBeVisible();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const band = page.locator(".dt-mobile-nav-shell");
  const bg = await band.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  // A point in the gutter beside the pill must hit the band, not page content.
  const inBand = await band.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 2, rect.bottom - 2);
    return !!hit && el.contains(hit);
  });
  expect(inBand).toBe(true);
});

test("navigation links and the auth control stay reachable at tablet and desktop widths", async ({
  page,
}) => {
  await installStatus(page);
  // toBeInViewport retries, so it waits out the drawer's slide-in animation.
  const withinViewport = (name: string) =>
    expect(page.getByRole("button", { name, exact: true })).toBeInViewport({
      ratio: 1,
    });
  // Tablet: compact navigation, every link and Sign Out inside the drawer.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/profile");
  await expect(page.getByRole("list", { name: "My datasets" })).toHaveCount(0);
  await withinViewport("Open navigation menu");
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByRole("menuitem", { name: "Home" })).toBeVisible();
  await expect(drawer.getByRole("menuitem", { name: "My Account" })).toBeVisible();
  await withinViewport("Sign Out");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  // Desktop: horizontal menu with Sign Out fully on screen.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeHidden();
  const desktopHeader = page.locator(".dt-nav-shell:not(.dt-mobile-nav-shell)");
  await expect(desktopHeader.getByRole("menuitem", { name: "Home" })).toBeVisible();
  await expect(desktopHeader.getByRole("button", { name: "Sign Out", exact: true })).toBeInViewport({ ratio: 1 });
});

test("keyboard users return to the Details control after closing the drawer", async ({
  page,
}) => {
  await installStatus(page);
  await page.goto("/profile");
  await details(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(details(page)).toBeFocused();
  await expect(page).toHaveURL(/\/profile$/);
});

test("mobile owners can inspect excluded datasets without desktop management tools", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installStatus(page, { audit_decision: "exclude" });
  await page.goto("/profile");
  await expect(page.getByRole("list", { name: "My datasets" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload Data" })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("mobile-desktop-only-note")).toBeVisible();
  await expect(page.getByTestId("dataset-image-check-77")).toContainText(
    "Excluded from public map",
  );
  const viewMap = page.getByRole("button", { name: "View map for dataset 77" });
  await expect(viewMap.locator(".anticon-environment")).toBeVisible();
  await expect(details(page)).toHaveText("Check details");
  await details(page).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText(
    "The image did not pass the quality check, so it is not on the public map. It stays in your account.",
  );
  await expect(drawer.getByTestId("dataset-image-quality")).toHaveText(
    "Excluded from public map",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await viewMap.click();
  await expect(page).toHaveURL(/\/dataset\/77$/);
});

test("an archived dataset opens from an email link without rejoining the active list", async ({
  page,
}) => {
  await installStatus(page, { archived: true });
  await page.goto("/profile?dataset=77");
  await expect(
    page.getByText("Archived dataset", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Forest survey.tif", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("dataset-processing-77")).toHaveCount(0);
});

test("queue failure is not presented as ready results", async ({ page }) => {
  await installStatus(page, {}, { queueFails: true });
  await page.goto("/profile");
  const cell = page.getByTestId("dataset-processing-77");
  await expect(cell).not.toContainText("Results ready");
  await expect(cell).toContainText("Status unavailable", { timeout: 20_000 });
});

test("the panel shows the dataset page's quality findings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installStatus(page);
  await page.goto("/profile?dataset=77");
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByTestId("dataset-image-quality")).toHaveText("Accepted");
  await expect(drawer.getByTestId("dataset-audit-georef")).toHaveText("About 2.6 m off");
  await expect(drawer).toContainText("June 12, 2024");
  await expect(drawer).toContainText("~2 July 2024");
  await expect(drawer.getByTestId("dataset-phenology-probability")).toHaveText("82%");
  await expect(drawer.getByTestId("dataset-audit-deadwood")).toContainText("1/16 major, 3 minor");
  await expect(drawer.getByTestId("dataset-audit-tree-cover")).toContainText("0/16 major, 2 minor");
  await drawer.getByTestId("dataset-audit-deadwood").getByText("1/16 major, 3 minor").click();
  await expect(drawer.getByTestId("dataset-audit-deadwood-reasoning")).toContainText(
    "Shadows under the canopy are marked as deadwood.",
  );
  for (const retired of ["Generated results", "Quality review", "Not yet reviewed", "Pending"]) {
    await expect(drawer).not.toContainText(retired);
  }
  await expect(drawer).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath("status-panel-finished.png") });
  // every row explains itself on its label
  await drawer.getByText("Phenology", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("peak green season");
});

test("the panel shows every finding as pending before the checks ran", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installStatus(
    page,
    { audit_decision: null },
    { audit: null },
  );
  await page.goto("/profile?dataset=77");
  const drawer = page.getByRole("dialog");
  for (const id of [
    "dataset-image-quality",
    "dataset-audit-georef",
    "dataset-audit-deadwood",
    "dataset-audit-tree-cover",
  ]) {
    await expect(drawer.getByTestId(id)).toContainText("Pending");
  }
  await expect(drawer).not.toContainText("Not checked");
  await expect(drawer).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath("status-panel-pending.png") });
});

test("the panel tells the owner an excluded dataset left the public map", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installStatus(
    page,
    { audit_decision: "exclude" },
    { audit: { ...finishedAudit, evaluation_decision: "exclude", evaluation_reason: "not_rgb" } },
  );
  await page.goto("/profile?dataset=77");
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByTestId("dataset-image-quality")).toHaveText(
    "Excluded from public map: not true colour",
  );
  await expect(drawer).toContainText("did not pass the quality check");
  // the other findings stay visible
  await expect(drawer.getByTestId("dataset-audit-georef")).toHaveText("About 2.6 m off");
  await expect(drawer).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath("status-panel-excluded.png") });
});

test("status deep link survives the sign-in redirect", async ({ page }) => {
  await page.goto("/profile?dataset=77");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fprofile%3Fdataset%3D77/);
});
