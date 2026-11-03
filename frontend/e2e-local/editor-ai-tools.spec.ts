import { expect, test } from "@playwright/test";
import { createAuditEditorFixture } from "./support/auditEditorFixture";

// AI and area tools of the label editor, against a local dataset with a deadwood prediction.
// The SAM service is mocked per test with page.route; saves go to the local database only.
const editor = createAuditEditorFixture("editor-ai-tools");

test.describe("label editor AI and area tools", () => {
  test.skip(
    process.env.E2E_LOCAL_AUDITOR_WRITE !== "1",
    "Set E2E_LOCAL_AUDITOR_WRITE=1 and start local Supabase/API/nginx before running this write suite.",
  );

  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => editor.setup());
  test.afterAll(() => editor.teardown());

  test("AI outlines a clicked tree, refines it with Shift-click, cuts with Alt-click and stops on S", async ({
    page,
  }) => {
    let samResponse: "fail" | "outline" = "fail";
    let drawnBox = { x1: 0, y1: 0, x2: 0, y2: 0 };
    let segmentRequests = 0;
    const sentPoints: number[][][] = [];
    await page.route("**/segment", async (route) => {
      segmentRequests += 1;
      const body = route.request().postData() ?? "";
      const points = /name="points"\r\n\r\n([^\r]*)/.exec(body)?.[1];
      if (points) sentPoints.push(JSON.parse(points));
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

    await editor.openDeadwoodEditor(page);
    const undo = page.getByRole("button", { name: /Undo/ });
    await expect(undo).toBeDisabled();

    const map = page.getByTestId("dataset-audit-map");
    const bounds = (await map.boundingBox())!;
    // The mocked model answers with this square (view pixels) for any prompt.
    drawnBox = {
      x1: Math.round(bounds.width * 0.4),
      y1: Math.round(bounds.height * 0.4),
      x2: Math.round(bounds.width * 0.6),
      y2: Math.round(bounds.height * 0.6),
    };
    const clickTree = async (fx: number, fy: number, modifier?: "Shift" | "Alt") => {
      if (modifier) await page.keyboard.down(modifier);
      await page.mouse.click(bounds.x + bounds.width * fx, bounds.y + bounds.height * fy);
      if (modifier) await page.keyboard.up(modifier);
    };

    await page.getByRole("button", { name: /AI \(S\)/ }).click();
    await expect(page.getByRole("button", { name: /Stop AI \(S\)/ })).toBeVisible();
    // The AI options show under the button only while AI is on, and the tool line names AI.
    await expect(page.getByTestId("ai-tool-panel")).toBeVisible();
    await expect(page.getByTestId("editor-active-tool")).toContainText("AI outline");
    await clickTree(0.5, 0.5);
    await expect(page.getByText("The AI segmentation service could not be reached")).toBeVisible();
    await expect(undo).toBeDisabled();

    // A click on a tree sends that one point, without a box, and adds the outline; AI stays on.
    samResponse = "outline";
    await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10_000 });
    await clickTree(0.5, 0.5);
    await expect(undo).toBeEnabled({ timeout: 10_000 });
    expect(sentPoints.at(-1)).toHaveLength(1);
    await expect(page.getByRole("button", { name: /Stop AI \(S\)/ })).toBeVisible();

    // Shift-click refines that outline: the same image with both points.
    await clickTree(0.55, 0.55, "Shift");
    await expect.poll(() => sentPoints.at(-1)?.length).toBe(2);

    // Alt-click is an AI cut: the outline under the click is cut out of the layer's polygons.
    const beforeCut = segmentRequests;
    await clickTree(0.5, 0.5, "Alt");
    await expect.poll(() => segmentRequests).toBe(beforeCut + 1);
    await expect(page.getByText("Nothing to cut there")).toHaveCount(0);

    // Stopping AI frees the map: clicks reach no model.
    await page.getByRole("button", { name: /Stop AI \(S\)/ }).click();
    await expect(page.getByTestId("ai-tool-panel")).toHaveCount(0);
    await expect(page.getByTestId("editor-active-tool")).toContainText("Select");
    const requestsAfterStop = segmentRequests;
    await clickTree(0.45, 0.45);
    await page.waitForTimeout(500);
    expect(segmentRequests).toBe(requestsAfterStop);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeHidden();
  });

  test("AI box (Shift-drag) on a screen wider than the service limit sends a shrunken view", async ({ page }) => {
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

    await editor.openDeadwoodEditor(page);
    const undo = page.getByRole("button", { name: /Undo/ });
    await expect(undo).toBeDisabled();

    await page.getByRole("button", { name: /AI \(S\)/ }).click();
    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    expect(bounds.width).toBeGreaterThan(2048);
    // Shift-drag draws the AI box.
    await page.keyboard.down("Shift");
    await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(undo).toBeEnabled({ timeout: 10_000 });
    expect(sentBoxes).toHaveLength(1);
    expect(Math.max(...sentBoxes[0])).toBeLessThanOrEqual(2048);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("area tools add an area and AI finds in an area, and both save as corrections", async ({ page }) => {
    await page.route("**/concepts", async (route) => {
      // Two outlines in the pixel space of the crop the editor sent.
      const square = (x: number, y: number) => [[x, -y], [x + 40, -y], [x + 40, -y - 40], [x, -y - 40], [x, -y]];
      await route.fulfill({
        json: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: { score: 0.9 }, geometry: { type: "Polygon", coordinates: [square(10, 10)] } },
            { type: "Feature", properties: { score: 0.6 }, geometry: { type: "Polygon", coordinates: [square(80, 80)] } },
          ],
        },
      });
    });
    const addsBefore = await editor.countCorrections("add");

    await editor.openDeadwoodEditor(page);

    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    const lasso = async (cx: number, cy: number, r: number) => {
      await page.mouse.move(cx + r, cy);
      await page.mouse.down();
      for (let a = 0; a <= 2 * Math.PI + 0.01; a += Math.PI / 12) {
        await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      await page.mouse.up();
    };

    // Add area: drag a lasso; it becomes a polygon of this layer.
    await page.keyboard.press("q");
    await lasso(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * 0.5, 60);
    await expect(page.getByRole("button", { name: /Undo/ })).toBeEnabled();

    // Find in area: custom prompt, preview, then Enter adds the candidates.
    await page.getByLabel("Text to find in area").fill("dead tree");
    await page.getByRole("button", { name: /Find in area/ }).click();
    await lasso(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.5, 90);
    // The second outline lies outside the drawn area and is clipped away.
    await expect(page.getByText("1 found (best of 2)", { exact: false })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/found \(best of/)).toBeHidden();

    await page.getByRole("button", { name: /Save/ }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => editor.countCorrections("add")).toBeGreaterThanOrEqual(addsBefore + 2);
  });

  test("a search still running when the editor is cancelled publishes nothing", async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/concepts", async (route) => {
      await held;
      await route.fulfill({
        json: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: { score: 0.9 },
            geometry: { type: "Polygon", coordinates: [[[10, -10], [60, -10], [60, -60], [10, -60], [10, -10]]] },
          }],
        },
      });
    });

    await editor.openDeadwoodEditor(page);

    const bounds = (await page.getByTestId("dataset-audit-map").boundingBox())!;
    const cx = bounds.x + bounds.width * 0.6;
    const cy = bounds.y + bounds.height * 0.5;
    await page.getByRole("button", { name: /Find in area/ }).click();
    await page.mouse.move(cx + 80, cy);
    await page.mouse.down();
    for (let a = 0; a <= 2 * Math.PI + 0.01; a += Math.PI / 12) {
      await page.mouse.move(cx + 80 * Math.cos(a), cy + 80 * Math.sin(a));
    }
    await page.mouse.up();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeHidden();
    release();
    await page.waitForTimeout(1_000);
    // Reopening the editor must not show the stale result as a preview.
    await page.getByRole("button", { name: "Edit labels" }).click();
    await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();
    await expect(page.getByText(/found/)).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});
