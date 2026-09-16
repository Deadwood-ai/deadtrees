import { expect, test } from "@playwright/test";

// /dataset/91001 is the seeded public QA dataset (docs/qa/fixtures.md); its
// detail map must sit behind the floating header exactly like the archive.
for (const route of ["/dataset", "/dataset/91001", "/deadtrees"]) {
  test(`${route} fills the viewport beneath an interactive floating header`, async ({ page }) => {
    await page.goto(route);
    const notice = page.getByRole("button", { name: "I Understand" });
    if (route === "/deadtrees") {
      await notice.click();
      await expect(notice).toBeHidden();
    }
    const reject = page.getByRole("button", { name: "Reject", exact: true });
    if (await reject.isVisible()) await reject.click();
    const viewport = page.locator(".ol-viewport").first();
    await expect(viewport).toBeVisible();
    await expect(page.locator(".ol-viewport canvas").first()).toBeVisible();
    // Preserve the same OpenLayers viewport across breakpoint changes.
    const original = await viewport.elementHandle();
    for (const size of [{ width: 1280, height: 720 }, { width: 768, height: 1024 },
      { width: 390, height: 844 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(size);
      await expect.poll(async () => viewport.evaluate(e => Math.round(e.getBoundingClientRect().height))).toBe(size.height);
      expect(await viewport.evaluate((e, old) => e === old, original)).toBe(true);
      const shell = page.locator(".dt-nav-shell:visible");
      await expect(shell).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(shell).toHaveCSS("pointer-events", "none");
      await expect.poll(() => page.evaluate(() => !!document.elementFromPoint(3, 3)?.closest(".ol-viewport"))).toBe(true);
      if (size.width < 1024) {
        if (route === "/dataset/91001") {
          await page.getByRole("button", { name: "info-circle Details" }).click();
          await expect(page.getByRole("dialog", { name: "Dataset Details" })).toBeVisible();
          await page.getByRole("dialog", { name: "Dataset Details" }).getByRole("button", { name: "Close", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Dataset Details" })).toBeHidden();
          await expect(page.getByRole("button", { name: "sliders Controls" })).toBeVisible();
        }
        await page.getByRole("button", { name: "Open navigation menu" }).click();
        await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
        await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
      }
      await page.screenshot({ path: `../.local/ui-preview/${route.slice(1).replace("/", "-")}-${size.width}.png` });
    }
    await page.goto("/about");
    await expect(page.getByRole("heading", { name: "The Initiative" })).toBeVisible();
    await expect(page.locator(".dt-nav-shell:visible")).toHaveCSS("background-color", "rgb(248, 250, 249)");
    await expect(page.locator(".dt-nav-shell:visible")).toHaveCSS("pointer-events", "auto");
  });
}

test("an explicit locate request explains an unavailable browser capability", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", { value: undefined });
  });
  await page.goto("/deadtrees");
  await page.getByRole("button", { name: "I Understand" }).click();
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  if (await reject.isVisible()) await reject.click();
  await expect(page.locator(".ol-viewport canvas").first()).toBeVisible();
  const error = page.getByText("This browser does not support location.", { exact: true });
  await expect(error).toHaveCount(0);
  await page.getByRole("button", { name: "Use current location", exact: true }).click();
  await expect(error).toBeVisible();
});
