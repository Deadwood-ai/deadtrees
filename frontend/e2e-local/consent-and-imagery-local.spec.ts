import { expect, test } from "@playwright/test";

import { acceptCookieConsent } from "./support/localAuth";

test("the consent banner leaves room for the Sign up button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/sign-up");
  const banner = page.getByRole("button", { name: "Accept" });
  await expect(banner).toBeVisible();
  const button = page.getByRole("button", { name: /sign up/i });
  // Scroll the form as a visitor would; before, the page could not scroll and
  // the banner kept covering the button.
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, 2000);
  const box = (await button.boundingBox())!;
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? "",
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toMatch(/sign up/i);
});

// /dataset/91001 is the seeded public QA dataset (docs/qa/fixtures.md).
test("failed drone imagery is explained over the map", async ({ page }) => {
  await acceptCookieConsent(page);
  await page.route("**/cogs/**", (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/dataset/91001");
  await expect(page.getByRole("heading", { name: "The drone imagery couldn’t load" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("QA Forest, DE")).toBeVisible();
});
