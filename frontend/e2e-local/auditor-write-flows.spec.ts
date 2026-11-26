import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const localDataRoot = process.env.LOCAL_DATA_ROOT || path.join(repoRoot, "data");
const rgbGeoTiffFixture = path.resolve(
  __dirname,
  "../test/fixtures/geotiff/upload-validation/rgb-real-crop.tif",
);

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const localApiUrl = process.env.VITE_LOCAL_API_URL || "http://localhost:8080/api/v1";

const uniqueRunId = randomUUID().replaceAll("-", "").slice(0, 12);
const auditorEmail = `auditor-write-${uniqueRunId}@example.com`;
const reporterEmail = `auditor-write-reporter-${uniqueRunId}@example.com`;
const auditorPassword = `Auditor-${uniqueRunId}!`;
const reporterPassword = `Reporter-${uniqueRunId}!`;
const cogPath = `auditor-write/${uniqueRunId}.tif`;
const cogFileName = `${uniqueRunId}.tif`;

let adminClient: SupabaseClient;
let anonClient: SupabaseClient;
let auditorUser: User;
let reporterUser: User;
let datasetId = 0;
let flagId = 0;
let privilegedUserId = 0;
let machinePredictionAoiId = 0;
let manualCorrectionAoiId = 0;

const machinePredictionGeometry = {
  type: "MultiPolygon",
  coordinates: [[[
    [13.405, 52.52],
    [13.405, 52.521],
    [13.406, 52.521],
    [13.406, 52.52],
    [13.405, 52.52],
  ]]],
};

test.describe("auditor local write flows", () => {
  test.skip(
    process.env.E2E_LOCAL_AUDITOR_WRITE !== "1",
    "Set E2E_LOCAL_AUDITOR_WRITE=1 and start local Supabase/API/nginx before running this write suite.",
  );

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    adminClient = createLocalSupabaseClient(
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    );
    anonClient = createLocalSupabaseClient(
      process.env.VITE_SUPABASE_ANON_KEY || requireEnv("SUPABASE_ANON_KEY"),
    );

    await expectLocalService(
      `${localSupabaseUrl}/auth/v1/settings`,
      "local Supabase",
    );
    await expectLocalService(`${localApiUrl}/`, "local API");

    await deleteAuthUsersByEmail(adminClient, auditorEmail);
    await deleteAuthUsersByEmail(adminClient, reporterEmail);

    auditorUser = await createConfirmedUser(auditorEmail, auditorPassword);
    reporterUser = await createConfirmedUser(reporterEmail, reporterPassword);
    privilegedUserId = await grantAuditPrivilege(auditorUser.id);
    datasetId = await createAuditableDataset();
    machinePredictionAoiId = await createMachinePredictionAoi();
    // The first scenario opens the deadwood editor, which needs a prediction.
    await seedDeadwoodPrediction();
    flagId = await createOpenFlag();
  });

  test.afterAll(async () => {
    await cleanupDataset();
    await cleanupAuditPrivilege();
    if (adminClient) {
      await deleteAuthUsersByEmail(adminClient, auditorEmail);
      await deleteAuthUsersByEmail(adminClient, reporterEmail);
    }
    fs.rmSync(path.join(localDataRoot, "cogs", cogPath), { force: true });
  });

  test("auditor acknowledges a user flag, draws AOI, and Save stores the answer as a person row", async ({
    page,
  }) => {
    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);

    await expect(
      page.getByRole("heading", { name: new RegExp(`Audit Review: ${datasetId}`) }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("status", { name: "Securing the review lock" })).toBeHidden({
      timeout: 20_000,
    });
    await expectAuditLeaseHolder(auditorUser.id);

    await expect(page.getByText("User-reported issues")).toBeVisible();
    await expect(page.getByText("Local auditor write issue")).toBeVisible();
    await page.getByRole("button", { name: "Acknowledge" }).click();
    await expectFlagStatus("acknowledged");

    // the dataset evaluation is the only verdict; the other checks report values
    const evaluation = await section(page, "Dataset evaluation");
    await evaluation.getByTestId("audit-evaluation-decision").getByText("OK", { exact: true }).click();
    await evaluation.getByLabel("Note on the decision").fill("Auditor local write integration completed.");

    await drawAuditAoi(page);
    await expect(page.getByText(/AOI defined/)).toBeVisible();
    await page.getByRole("button", { name: /^save Save AOI$/i }).click();
    await expect(page.getByText("Unsaved AOI edits")).toBeHidden({
      timeout: 10_000,
    });
    manualCorrectionAoiId = await expectManualCorrectionSaved(undefined, 2);
    await addManualCorrectionMetadata();

    await drawAuditAoi(page);
    const aoiCard = await section(page, "Area of interest");
    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();

    await page.getByRole("button", { name: "Edit deadwood cover" }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await aoiCard.getByRole("button", { name: "Edit" }).click();
    await expect(aoiCard.getByRole("button", { name: "Cut" })).toBeVisible();
    await aoiCard.getByRole("button", { name: "Cancel" }).click();

    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await aoiCard.getByRole("button", { name: /Undo AOI Change/i }).click();
    await expect(aoiCard.getByText(/AOI defined \(2 polygons\)/)).toBeVisible();

    await drawAuditAoi(page);
    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await aoiCard.getByRole("button", { name: "Edit" }).click();
    await expect(aoiCard.getByRole("button", { name: "Cut" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Merge" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Clip" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(aoiCard.getByRole("button", { name: "Undo" })).toBeVisible();
    await aoiCard.getByRole("button", { name: "Cancel" }).click();
    await expect(aoiCard.getByText(/AOI defined \(3 polygons\)/)).toBeVisible();
    await expect(page.getByText("Unsaved AOI edits")).toBeVisible();

    await page.getByRole("button", { name: /^save Save AOI$/i }).click();
    await expect(page.getByText("Unsaved AOI edits")).toBeHidden({
      timeout: 10_000,
    });
    await expectManualCorrectionSaved(manualCorrectionAoiId, 3, {
      image_quality: 2,
      notes: "Auditor metadata to preserve",
    });

    await page.getByRole("button", { name: /^save Save$/i }).click();
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, {
      timeout: 20_000,
    });

    await expectAuditSideEffects();
  });

  test("saving the review releases the audit lease", async ({ page }) => {
    await setFlagStatus("acknowledged");
    const answersBefore = await countPersonAnswers();
    await installAuditorSession(page);
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);

    // nothing changed on the page: Save stores nothing and returns to the list
    await page.getByRole("button", { name: /^save Save$/i }).click();
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 20_000 });

    await expectAuditLeaseHolder(null);
    expect(await countPersonAnswers()).toBe(answersBefore);
  });

  test("a live lease is respected, an abandoned one is reclaimed, and page exit releases it", async ({
    page,
  }) => {
    // The first scenario acknowledges the flag; this one checks it stays locked.
    await setFlagStatus("open");
    const answersBefore = await countPersonAnswers();
    await installAuditorSession(page);

    // Another auditor is actively auditing: this auditor is sent back to the queue.
    await setAuditLease(reporterUser.id, 600);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(
      page.getByText(`This dataset is being audited by ${reporterEmail}`).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 10_000 });
    await expectAuditLeaseHolder(reporterUser.id);

    // The other auditor's page went away without releasing: the lease is reclaimable.
    await setAuditLease(reporterUser.id, -1);
    await seedDeadwoodPrediction();
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);
    await expect(page.getByRole("button", { name: "Edit deadwood cover" })).toBeVisible({ timeout: 20_000 });

    // This page was inactive past expiry and someone else claimed the dataset.
    await setAuditLease(reporterUser.id, 600);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByText("Saving is turned off on this page")).toBeVisible();
    await expect(page.getByRole("button", { name: /^save Save$/i })).toHaveCount(0);
    // Prediction edits are not offered from a page that lost the lease.
    await expect(page.getByRole("button", { name: "Edit deadwood cover" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
    // nothing changed on the page: it leaves without asking
    await page.getByRole("button", { name: "Back to the Audit Review" }).click();
    await expect(page).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 10_000 });
    // Leaving must not clear the new holder's lease.
    await expectAuditLeaseHolder(reporterUser.id);

    // Closing or navigating the tab away releases the lease immediately.
    await deleteRows("dataset_audit_locks", "dataset_id", datasetId);
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto("about:blank");
    await expectAuditLeaseHolder(null);

    expect(await countPersonAnswers()).toBe(answersBefore);
  });

  test("a second tab of the same auditor cannot displace the lease page until they continue there", async ({
    context,
    page,
  }) => {
    await setFlagStatus("open");
    await installAuditorSession(page);
    await openAuditDetail(page);
    await expectAuditLeaseHolder(auditorUser.id);
    const firstLease = (await readAuditLease())?.lease_id;
    // Unsaved AOI work on the first tab.
    await drawAuditAoi(page);
    await expect(page.getByText("Unsaved AOI edits")).toBeVisible();

    const secondTab = await context.newPage();
    await secondTab.goto(`/dataset-audit/${datasetId}`);
    await expect(
      secondTab.getByText("You have this dataset open in another tab or window."),
    ).toBeVisible({ timeout: 20_000 });
    expect((await readAuditLease())?.lease_id).toBe(firstLease);

    await secondTab.getByRole("button", { name: "Continue here" }).click();
    await expect(
      secondTab.getByRole("heading", { name: new RegExp(`Audit Review: ${datasetId}`) }),
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await readAuditLease())?.lease_id).not.toBe(firstLease);

    // Before its next renewal the first tab still believes it holds the lease. Its flag
    // review is rejected by the server, and the rejection makes it notice the takeover.
    const staleFlagReview = page.waitForResponse((response) =>
      response.url().includes("/rpc/update_flag_status"),
    );
    await page.getByRole("button", { name: "Acknowledge" }).click();
    const rejected = await staleFlagReview;
    expect(rejected.status()).toBeGreaterThanOrEqual(400);
    expect(rejected.request().headers()["x-audit-lease"]).toBe(firstLease);
    await expectFlagStatus("open");
    await expect(page.getByText("You continued this review in another tab or window.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^save Save$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save AOI/ })).toBeDisabled();

    // the page that holds the lease acknowledges the report and saves
    await secondTab.getByRole("button", { name: "Acknowledge" }).click();
    await expectFlagStatus("acknowledged");
    await secondTab.getByRole("button", { name: /^save Save$/i }).click();
    await expect(secondTab).toHaveURL(/\/dataset-audit(?:\?.*)?$/, { timeout: 20_000 });
    await expectAuditLeaseHolder(null);
    await secondTab.close();
  });

  test("AI box reports an unreachable model, adds a returned outline and refines it with clicks", async ({
    page,
  }) => {
    let samResponse: "fail" | "outline" = "fail";
    let drawnBox = { x1: 0, y1: 0, x2: 0, y2: 0 };
    const sentPoints: string[] = [];
    await page.route("**/segment", async (route) => {
      const body = route.request().postData() ?? "";
      const points = /name="points"\r\n\r\n([^\r]*)/.exec(body)?.[1];
      if (points) sentPoints.push(points);
      if (samResponse === "fail") {
        await route.abort("connectionrefused");
        return;
      }
      const { x1, y1, x2, y2 } = drawnBox;
      await route.fulfill({
        json: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[[x1, -y1], [x2, -y1], [x2, -y2], [x1, -y2], [x1, -y1]]],
            },
          }],
        },
      });
    });

    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(page.getByRole("status", { name: "Securing the audit lock" })).toBeHidden({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Edit deadwood cover" }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();
    const undo = page.getByRole("button", { name: /Undo/ });
    await expect(undo).toBeDisabled();

    const drawAiBox = async () => {
      await page.getByRole("button", { name: /AI \(S\)/ }).click();
      const map = page.getByTestId("dataset-audit-map");
      const bounds = await map.boundingBox();
      if (!bounds) throw new Error("Audit map is not visible for the AI box.");
      drawnBox = {
        x1: Math.round(bounds.width * 0.4),
        y1: Math.round(bounds.height * 0.4),
        x2: Math.round(bounds.width * 0.6),
        y2: Math.round(bounds.height * 0.6),
      };
      await page.mouse.click(bounds.x + drawnBox.x1, bounds.y + drawnBox.y1);
      await page.mouse.click(bounds.x + drawnBox.x2, bounds.y + drawnBox.y2);
    };

    await drawAiBox();
    await expect(page.getByText("The AI segmentation service could not be reached")).toBeVisible();
    await expect(page.getByRole("button", { name: /AI \(S\)/ })).toBeEnabled();
    await expect(undo).toBeDisabled();

    samResponse = "outline";
    await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10_000 });
    await drawAiBox();
    await expect(undo).toBeEnabled({ timeout: 10_000 });

    // While AI stays on, a click refines the outline: it is sent as a point with the same box.
    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    await expect.poll(() => sentPoints.length).toBe(1);
    expect(JSON.parse(sentPoints[0])).toHaveLength(1);
    // Undo removes the outline and ends AI mode: later map clicks reach no model.
    await expect(page.getByRole("button", { name: /Finish AI \(S\)/ })).toBeVisible();
    await undo.click();
    await expect(page.getByRole("button", { name: /Finish AI/ })).toHaveCount(0);
    await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.45);
    await page.waitForTimeout(500);
    expect(sentPoints).toHaveLength(1);

    // Cancelling while AI is on ends the session too.
    await drawAiBox();
    await expect(page.getByRole("button", { name: /Finish AI \(S\)/ })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeHidden();
    await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.45);
    await page.waitForTimeout(500);
    expect(sentPoints).toHaveLength(1);
  });

  test("AI box on a screen wider than the service limit sends a shrunken view", async ({ page }) => {
    await page.setViewportSize({ width: 2600, height: 1300 });
    const sentBoxes: number[][] = [];
    await page.route("**/segment", async (route) => {
      const body = route.request().postData() ?? "";
      const box = JSON.parse(/name="bboxes"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? "[0,0,1,1]") as number[];
      if (box[2] - box[0] > 2) sentBoxes.push(box);
      const [x1, y1, x2, y2] = box;
      await route.fulfill({
        json: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {},
            geometry: { type: "Polygon", coordinates: [[[x1, -y1], [x2, -y1], [x2, -y2], [x1, -y2], [x1, -y1]]] },
          }],
        },
      });
    });

    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(page.getByRole("status", { name: "Securing the audit lock" })).toBeHidden({ timeout: 20_000 });
    // The previous test's page may still hold this auditor's lease.
    const continueHere = page.getByRole("button", { name: "Continue here" });
    const editDeadwood = page.getByRole("button", { name: "Edit deadwood cover" });
    await expect(editDeadwood.or(continueHere).first()).toBeVisible({ timeout: 20_000 });
    if (await continueHere.isVisible()) await continueHere.click();
    await editDeadwood.click();
    const undo = page.getByRole("button", { name: /Undo/ });
    await expect(undo).toBeDisabled();

    await page.getByRole("button", { name: /AI \(S\)/ }).click();
    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    expect(bounds.width).toBeGreaterThan(2048);
    await page.mouse.click(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.4);
    await page.mouse.click(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.6);
    await expect(undo).toBeEnabled({ timeout: 10_000 });
    expect(sentBoxes).toHaveLength(1);
    expect(Math.max(...sentBoxes[0])).toBeLessThanOrEqual(2048);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("manual drawing keeps the polygon open on a click near the previous vertex", async ({ page }) => {
    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(page.getByRole("status", { name: "Securing the audit lock" })).toBeHidden({
      timeout: 20_000,
    });
    const continueHere = page.getByRole("button", { name: "Continue here" });
    const editDeadwood = page.getByRole("button", { name: "Edit deadwood cover" });
    await expect(editDeadwood.or(continueHere).first()).toBeVisible({ timeout: 20_000 });
    if (await continueHere.isVisible()) await continueHere.click();
    await editDeadwood.click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();
    await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10_000 });

    // The editing sidebar covers the left third of the map and the toolbar its right edge.
    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    const at = (fx: number, fy: number) => ({ x: bounds.x + bounds.width * fx, y: bounds.y + bounds.height * fy });
    // Labelers place vertices one by one, slower than a double-click.
    const clickSlowly = async (point: { x: number; y: number }) => {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(700);
    };
    const drawButton = page.getByRole("button", { name: /Draw \(A\)/ });
    const stopButton = page.getByRole("button", { name: /Stop \(A\)/ });

    await drawButton.click();
    await expect(stopButton).toBeVisible();
    const first = at(0.45, 0.3);
    const third = at(0.6, 0.5);
    await clickSlowly(first);
    await clickSlowly(at(0.6, 0.3));
    await clickSlowly(third);
    // A vertex 6 px from the previous one used to close the polygon.
    await clickSlowly({ x: third.x - 6, y: third.y + 3 });
    await expect(stopButton).toBeVisible();
    await clickSlowly(at(0.45, 0.5));
    await expect(stopButton).toBeVisible();
    // A click on the first vertex closes it.
    await clickSlowly(first);
    await expect(drawButton).toBeVisible();

    // A double-click still finishes a polygon.
    await drawButton.click();
    await clickSlowly(at(0.5, 0.6));
    await clickSlowly(at(0.6, 0.6));
    await page.mouse.dblclick(at(0.6, 0.75).x, at(0.6, 0.75).y);
    await expect(drawButton).toBeVisible();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("a double click on Save stores the drawn polygon once", async ({ page }) => {
    await seedDeadwoodPrediction();
    const { data: label, error: labelError } = await adminClient
      .from("v2_labels")
      .select("id")
      .eq("dataset_id", datasetId)
      .eq("label_data", "deadwood")
      .single();
    expect(labelError).toBeNull();
    const countAdds = async () => {
      const { count, error } = await adminClient
        .from("v2_geometry_corrections")
        .select("id", { count: "exact", head: true })
        .eq("label_id", label!.id)
        .eq("operation", "add");
      expect(error).toBeNull();
      return count ?? 0;
    };
    const addsBefore = await countAdds();

    // A slow save leaves time for the second click, as on a slow connection.
    await page.route("**/rest/v1/rpc/save_prediction_corrections", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(page.getByRole("status", { name: "Securing the audit lock" })).toBeHidden({
      timeout: 20_000,
    });
    const continueHere = page.getByRole("button", { name: "Continue here" });
    const editDeadwood = page.getByRole("button", { name: "Edit deadwood cover" });
    await expect(editDeadwood.or(continueHere).first()).toBeVisible({ timeout: 20_000 });
    if (await continueHere.isVisible()) await continueHere.click();
    await editDeadwood.click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();

    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    const at = (fx: number, fy: number) => ({ x: bounds.x + bounds.width * fx, y: bounds.y + bounds.height * fy });
    await page.getByRole("button", { name: /Draw \(A\)/ }).click();
    for (const point of [at(0.5, 0.3), at(0.6, 0.3), at(0.55, 0.4), at(0.5, 0.3)]) {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(700);
    }
    await expect(page.getByRole("button", { name: /Draw \(A\)/ })).toBeVisible();

    await page.getByRole("button", { name: /Save \(⌘S\)/ }).dblclick();
    await expect(page.getByText("Corrections saved successfully!").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(await countAdds()).toBe(addsBefore + 1);

    // The saved corrections would block deleting the seeded label after the suite.
    const { error: cleanupError } = await adminClient
      .from("v2_geometry_corrections")
      .delete()
      .eq("label_id", label!.id);
    expect(cleanupError).toBeNull();
  });

  test("a freehand stroke keeps the polygon open unless it ends on the first vertex", async ({ page }) => {
    await installAuditorSession(page);
    await page.goto(`/dataset-audit/${datasetId}`);
    await dismissCookieBanner(page);
    await expect(page.getByRole("status", { name: "Securing the audit lock" })).toBeHidden({
      timeout: 20_000,
    });
    const continueHere = page.getByRole("button", { name: "Continue here" });
    const editDeadwood = page.getByRole("button", { name: "Edit deadwood cover" });
    await expect(editDeadwood.or(continueHere).first()).toBeVisible({ timeout: 20_000 });
    if (await continueHere.isVisible()) await continueHere.click();
    await editDeadwood.click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();
    await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10_000 });

    // The editing sidebar covers the left third of the map and the toolbar its right edge.
    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    const at = (fx: number, fy: number) => ({ x: bounds.x + bounds.width * fx, y: bounds.y + bounds.height * fy });
    const stroke = async (points: { x: number; y: number }[]) => {
      await page.keyboard.down("Shift");
      await page.mouse.move(points[0].x, points[0].y);
      await page.mouse.down();
      for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await page.waitForTimeout(700);
    };
    const drawButton = page.getByRole("button", { name: /Draw \(A\)/ });
    const stopButton = page.getByRole("button", { name: /Stop \(A\)/ });

    await drawButton.click();
    const start = at(0.45, 0.3);
    await stroke([start, at(0.55, 0.28), at(0.6, 0.35)]);
    // Releasing the stroke away from its start used to finish the polygon.
    await expect(stopButton).toBeVisible();
    // A Shift-click without a drag used to throw the outline away.
    await page.keyboard.down("Shift");
    await page.mouse.click(at(0.6, 0.45).x, at(0.6, 0.45).y);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(700);
    await expect(stopButton).toBeVisible();
    // Clicks and further strokes extend the same outline.
    await page.mouse.click(at(0.6, 0.5).x, at(0.6, 0.5).y);
    await page.waitForTimeout(700);
    await expect(stopButton).toBeVisible();
    // A stroke that ends on the first vertex closes it.
    await stroke([at(0.6, 0.5), at(0.5, 0.52), at(0.45, 0.45), start]);
    await expect(drawButton).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("freehand-polygon.png"),
      clip: { x: bounds.x + bounds.width * 0.4, y: bounds.y + bounds.height * 0.2, width: bounds.width * 0.25, height: bounds.height * 0.4 },
    });
    await expect(page.getByRole("button", { name: /Undo/ })).toBeEnabled();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});

async function expectLocalService(url: string, name: string) {
  const response = await fetch(url).catch((error) => {
    throw new Error(`${name} is not reachable at ${url}: ${String(error)}`);
  });

  if (!response.ok) {
    throw new Error(`${name} returned ${response.status} for ${url}`);
  }
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for the local auditor write suite.`);
  }
  return value;
}

function createLocalSupabaseClient(key: string) {
  return createClient(localSupabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function createConfirmedUser(email: string, password: string) {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw error ?? new Error(`Failed to create local user ${email}`);
  }

  return data.user;
}

async function findAuthUserByEmail(client: SupabaseClient, email: string) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 100,
    });

    if (error) {
      throw error;
    }

    const user = data.users.find((candidate) => candidate.email === email);
    if (user) {
      return user;
    }

    if (data.users.length < 100) {
      return null;
    }
  }

  return null;
}

async function deleteAuthUsersByEmail(client: SupabaseClient, email: string) {
  let user = await findAuthUserByEmail(client, email);

  while (user) {
    const { error } = await client.auth.admin.deleteUser(user.id);
    if (error) {
      throw error;
    }
    user = await findAuthUserByEmail(client, email);
  }
}

async function grantAuditPrivilege(userId: string) {
  const { data, error } = await adminClient
    .from("privileged_users")
    .insert({
      user_id: userId,
      can_upload_private: false,
      can_view_all_private: false,
      can_audit: true,
    })
    .select("id")
    .single();

  expect(error).toBeNull();
  return data.id as number;
}

async function createAuditableDataset() {
  const { data: dataset, error: datasetError } = await adminClient
    .from("v2_datasets")
    .insert({
      file_name: `auditor-write-${uniqueRunId}.tif`,
      user_id: reporterUser.id,
      license: "CC BY",
      platform: "drone",
      authors: ["Local Auditor Write Reporter"],
      data_access: "public",
      aquisition_year: 2024,
      aquisition_month: 5,
      aquisition_day: 6,
      additional_information: "Local auditor write integration fixture",
    })
    .select("id")
    .single();

  expect(datasetError).toBeNull();
  const createdDatasetId = dataset.id as number;

  const { error: statusError } = await adminClient.from("v2_statuses").insert({
    dataset_id: createdDatasetId,
    current_status: "idle",
    is_upload_done: true,
    is_ortho_done: true,
    is_cog_done: true,
    is_thumbnail_done: true,
    is_deadwood_done: true,
    is_forest_cover_done: true,
    is_metadata_done: true,
    is_combined_model_done: true,
    has_error: false,
  });
  expect(statusError).toBeNull();

  const localCogFile = path.join(localDataRoot, "cogs", cogPath);
  fs.mkdirSync(path.dirname(localCogFile), { recursive: true });
  fs.copyFileSync(rgbGeoTiffFixture, localCogFile);

  const { error: cogError } = await adminClient.from("v2_cogs").insert({
    dataset_id: createdDatasetId,
    cog_file_name: cogFileName,
    version: 1,
    cog_file_size: fs.statSync(localCogFile).size,
    cog_info: {},
    cog_processing_runtime: 0.1,
    cog_path: cogPath,
  });
  expect(cogError).toBeNull();

  return createdDatasetId;
}

async function createOpenFlag() {
  const { data, error } = await adminClient
    .from("dataset_flags")
    .insert({
      dataset_id: datasetId,
      created_by: reporterUser.id,
      is_ortho_mosaic_issue: true,
      is_prediction_issue: false,
      description: "Local auditor write issue",
      status: "open",
    })
    .select("id")
    .single();

  expect(error).toBeNull();
  return data.id as number;
}

async function createMachinePredictionAoi() {
  const { data, error } = await adminClient
    .from("v2_aois")
    .insert({
      dataset_id: datasetId,
      user_id: reporterUser.id,
      geometry: machinePredictionGeometry,
      is_whole_image: false,
      source: "ml_prediction",
      notes: "Auto-generated by aoi_segmentation_v1",
    })
    .select("id")
    .single();

  expect(error).toBeNull();
  return data.id as number;
}

async function installAuditorSession(page: Page) {
  const login = await anonClient.auth.signInWithPassword({
    email: auditorEmail,
    password: auditorPassword,
  });
  expect(login.error).toBeNull();
  expect(login.data.user?.id).toBe(auditorUser.id);
  expect(login.data.session).toBeTruthy();

  await page.addInitScript((session) => {
    window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
  }, login.data.session);
}

/** Opens an audit section (one is open at a time) and returns it. */
const section = async (page: Page, title: string) => {
  const header = page.getByRole("button", { name: new RegExp(`^\\d\\. ${title}`) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  return page.locator("section").filter({ has: header });
};

async function dismissCookieBanner(page: Page) {
  await page
    .getByRole("button", { name: "Accept" })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
}

async function drawAuditAoi(page: Page) {
  await expect(page.getByTestId("dataset-audit-map")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-testid="dataset-audit-map"] .ol-viewport').first(),
  ).toBeVisible({ timeout: 20_000 });

  const aoiCard = await section(page, "Area of interest");
  const drawButton = aoiCard.getByRole("button", { name: "Draw AOI Polygon" });
  if (await drawButton.isVisible()) {
    await drawButton.click();
  } else {
    await aoiCard.getByRole("button", { name: "Add" }).click();
  }

  // Back-to-back edits stack status toasts down into the map centre, where they
  // swallow the clicks that should add polygon vertices.
  await expect(page.locator(".ant-message-notice")).toHaveCount(0, {
    timeout: 10_000,
  });

  const map = page.getByTestId("dataset-audit-map");
  const box = await map.boundingBox();
  if (!box) {
    throw new Error("Audit map is not visible for AOI drawing.");
  }

  const points = [
    { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 },
    { x: box.x + box.width * 0.56, y: box.y + box.height * 0.45 },
    { x: box.x + box.width * 0.56, y: box.y + box.height * 0.56 },
    { x: box.x + box.width * 0.45, y: box.y + box.height * 0.56 },
  ];

  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  await page.mouse.click(points[2].x, points[2].y);
  await page.mouse.dblclick(points[3].x, points[3].y);
}

async function expectManualCorrectionSaved(
  expectedId?: number,
  expectedPolygonCount?: number,
  expectedMetadata?: { image_quality: number; notes: string },
) {
  let correctionId = 0;

  await expect
    .poll(async () => {
      const { data, error } = await adminClient
        .from("v2_aois")
        .select("id,source,corrected_from_aoi_id,geometry,image_quality,notes")
        .eq("dataset_id", datasetId)
        .eq("source", "manual_correction")
        .single();
      expect(error).toBeNull();
      correctionId = data.id as number;
      return {
        source: data.source,
        corrected_from_aoi_id: data.corrected_from_aoi_id,
        polygonCount: data.geometry?.coordinates?.length,
        image_quality: data.image_quality,
        notes: data.notes,
      };
    })
    .toMatchObject({
      source: "manual_correction",
      corrected_from_aoi_id: machinePredictionAoiId,
      ...(expectedPolygonCount === undefined ? {} : { polygonCount: expectedPolygonCount }),
      ...(expectedMetadata ?? {}),
    });

  if (expectedId) {
    expect(correctionId).toBe(expectedId);
  }
  return correctionId;
}

async function addManualCorrectionMetadata() {
  const { error } = await adminClient
    .from("v2_aois")
    .update({
      image_quality: 2,
      notes: "Auditor metadata to preserve",
    })
    .eq("id", manualCorrectionAoiId);

  expect(error).toBeNull();
}

async function readAuditLease() {
  const { data, error } = await adminClient
    .from("dataset_audit_locks")
    .select("holder_id,lease_id,expires_at")
    .eq("dataset_id", datasetId)
    .maybeSingle();
  expect(error).toBeNull();
  return data as { holder_id: string; lease_id: string; expires_at: string } | null;
}

async function expectAuditLeaseHolder(holderId: string | null) {
  await expect
    .poll(async () => {
      const lease = await readAuditLease();
      return lease && Date.parse(lease.expires_at) > Date.now() ? lease.holder_id : null;
    })
    .toBe(holderId);
}

async function setAuditLease(holderId: string, expiresInSeconds: number) {
  const { error } = await adminClient.from("dataset_audit_locks").upsert({
    dataset_id: datasetId,
    holder_id: holderId,
    lease_id: randomUUID(),
    expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  });
  expect(error).toBeNull();
}

async function openAuditDetail(page: Page) {
  await page.goto(`/dataset-audit/${datasetId}`);
  await dismissCookieBanner(page);
  await expect(
    page.getByRole("heading", { name: new RegExp(`Audit Review: ${datasetId}`) }),
  ).toBeVisible({ timeout: 20_000 });
}

// The audit map offers prediction edits only when a preferred model prediction exists.
async function seedDeadwoodPrediction() {
  const { count, error: countError } = await adminClient
    .from("v2_labels")
    .select("id", { count: "exact", head: true })
    .eq("dataset_id", datasetId)
    .eq("label_data", "deadwood");
  expect(countError).toBeNull();
  if (count) return;
  const { data: preference, error: preferenceError } = await adminClient
    .from("v2_model_preferences")
    .select("model_config")
    .eq("label_data", "deadwood")
    .single();
  expect(preferenceError).toBeNull();
  const { error } = await adminClient.from("v2_labels").insert({
    dataset_id: datasetId,
    user_id: reporterUser.id,
    label_source: "model_prediction",
    label_type: "semantic_segmentation",
    label_data: "deadwood",
    model_config: preference.model_config,
  });
  expect(error).toBeNull();
}

async function setFlagStatus(status: "open" | "acknowledged") {
  const { error } = await adminClient
    .from("dataset_flags")
    .update({ status })
    .eq("id", flagId);
  expect(error).toBeNull();
}

/** The person rows of audit.assessments on the test dataset. */
async function readPersonAnswers() {
  const { data, error } = await adminClient
    .schema("audit")
    .from("assessments")
    .select("check_key,layer,verdict,output,reason_text,assessor_user_id,imported_from")
    .eq("dataset_id", datasetId)
    .eq("assessor_kind", "person")
    .order("id");
  expect(error).toBeNull();
  return data ?? [];
}

const countPersonAnswers = async () => (await readPersonAnswers()).length;

async function expectFlagStatus(status: string) {
  await expect
    .poll(async () => {
      const { data, error } = await adminClient
        .from("dataset_flags")
        .select("status")
        .eq("id", flagId)
        .single();
      expect(error).toBeNull();
      return data.status;
    })
    .toBe(status);
}

async function expectAuditSideEffects() {
  // Save stores the reviewer's answer as a person row; nothing writes the legacy audit
  expect(await readPersonAnswers()).toEqual([
    {
      check_key: "dataset_evaluation",
      layer: "image",
      verdict: "ok",
      output: { cog_issue: false, thumbnail_issue: false },
      reason_text: "Auditor local write integration completed.",
      assessor_user_id: auditorUser.id,
      imported_from: null,
    },
  ]);
  const { count: legacyAudits, error: legacyError } = await adminClient
    .from("dataset_audit")
    .select("dataset_id", { count: "exact", head: true })
    .eq("dataset_id", datasetId);
  expect(legacyError).toBeNull();
  expect(legacyAudits).toBe(0);

  const { data: aois, error: aoiError } = await adminClient
    .from("v2_aois")
    .select("id,dataset_id,user_id,is_whole_image,source,corrected_from_aoi_id,geometry,notes")
    .eq("dataset_id", datasetId)
    .order("created_at");
  expect(aoiError).toBeNull();
  expect(aois).toHaveLength(2);
  expect(aois?.[0]).toMatchObject({
    id: machinePredictionAoiId,
    dataset_id: datasetId,
    source: "ml_prediction",
    corrected_from_aoi_id: null,
    geometry: machinePredictionGeometry,
    notes: "Auto-generated by aoi_segmentation_v1",
  });
  expect(aois?.[1]).toMatchObject({
    id: manualCorrectionAoiId,
    dataset_id: datasetId,
    user_id: auditorUser.id,
    is_whole_image: false,
    source: "manual_correction",
    corrected_from_aoi_id: machinePredictionAoiId,
  });
  expect(aois?.[1].geometry).toMatchObject({ type: "MultiPolygon" });

  await expectAuditLeaseHolder(null);

  const { data: flag, error: flagError } = await adminClient
    .from("dataset_flags")
    .select("status,resolved_by")
    .eq("id", flagId)
    .single();
  expect(flagError).toBeNull();
  expect(flag).toEqual({ status: "acknowledged", resolved_by: null });

  const { data: history, error: historyError } = await adminClient
    .from("dataset_flag_status_history")
    .select("old_status,new_status,changed_by")
    .eq("flag_id", flagId)
    .order("changed_at");
  expect(historyError).toBeNull();
  expect(history).toEqual([
    {
      old_status: "open",
      new_status: "acknowledged",
      changed_by: auditorUser.id,
    },
  ]);
}

async function cleanupAuditPrivilege() {
  if (!privilegedUserId) return;
  await deleteRows("privileged_users", "id", privilegedUserId);
  privilegedUserId = 0;
}

async function cleanupDataset() {
  if (!datasetId) return;

  if (flagId) {
    await deleteRows("dataset_flag_status_history", "flag_id", flagId);
  }
  await deleteRows("dataset_flags", "dataset_id", datasetId);
  await deleteRows("dataset_audit_locks", "dataset_id", datasetId);
  const { error: answersError } = await adminClient.schema("audit").from("assessments").delete().eq("dataset_id", datasetId);
  if (answersError) throw new Error(`Failed to clean audit.assessments of dataset ${datasetId}: ${answersError.message}`);
  await deleteRows("v2_aois", "dataset_id", datasetId);
  await deleteRows("v2_labels", "dataset_id", datasetId);
  await deleteRows("v2_cogs", "dataset_id", datasetId);
  await deleteRows("v2_thumbnails", "dataset_id", datasetId);
  await deleteRows("v2_orthos", "dataset_id", datasetId);
  await deleteRows("v2_statuses", "dataset_id", datasetId);
  await deleteRows("v2_datasets", "id", datasetId);

  datasetId = 0;
  flagId = 0;
}

async function deleteRows(
  table: string,
  column: string,
  value: number | string,
) {
  const { error } = await adminClient.from(table).delete().eq(column, value);
  if (error) {
    throw new Error(
      `Failed to clean ${table}.${column}=${String(value)}: ${error.message}`,
    );
  }
}
