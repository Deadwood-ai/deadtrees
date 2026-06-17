#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="${1:-$REPO_ROOT/.local/qa-runs/playwright-upload-probe}"
FRONTEND_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${PLAYWRIGHT_PORT:-5173}}"
UPLOAD_FILE="${QA_UPLOAD_FILE:-$REPO_ROOT/frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif}"
EMAIL="${QA_CONTRIBUTOR_EMAIL:-qa-contributor-local@example.com}"
PASSWORD="${QA_PASSWORD:-DeadTreesQA-Local-1!}"

mkdir -p "$RUN_DIR"

node - "$REPO_ROOT" "$RUN_DIR" "$FRONTEND_URL" "$UPLOAD_FILE" "$EMAIL" "$PASSWORD" <<'JS'
const fs = require("fs");
const path = require("path");

const [repoRoot, runDir, frontendUrl, uploadFile, email, password] = process.argv.slice(2);
const { chromium } = require(path.join(repoRoot, "frontend/node_modules/playwright"));

(async () => {
  const resultPath = path.join(runDir, "result.md");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: undefined,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const evidence = [];
  let status = "blocked";
  let category = "tooling-limitation";

  try {
    await page.goto(`${frontendUrl}/sign-in`, { waitUntil: "domcontentloaded" });
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/profile/, { timeout: 15000 });
    evidence.push(`Signed in as ${email}; URL ${page.url()}.`);

    await page.getByRole("button", { name: /upload data/i }).click();
    await page.getByTestId("contributor-upload-modal").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("contributor-upload-dropzone").setInputFiles(uploadFile);
    evidence.push(`Attached ${path.relative(repoRoot, uploadFile)} to contributor upload input.`);

    const fileName = path.basename(uploadFile);
    const inputFileName = await page
      .getByTestId("contributor-upload-dropzone")
      .locator('input[type="file"]')
      .evaluate((input) => input.files?.[0]?.name || "")
      .catch(() => "");
    const fileNameVisible = await page.getByText(fileName).first().isVisible({ timeout: 5000 }).catch(() => false);
    evidence.push(`Input file name: ${inputFileName || "empty"}.`);
    evidence.push(`Uploaded file name visible: ${fileNameVisible}.`);
    const uploadAccepted = inputFileName === fileName || fileNameVisible;
    status = uploadAccepted ? "pass" : "needs-human-review";
    category = uploadAccepted ? "none" : "tooling-limitation";
  } catch (error) {
    evidence.push(`Error: ${error.message}`);
    await page.screenshot({ path: path.join(runDir, "upload-probe-failure.png"), fullPage: false }).catch(() => {});
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    resultPath,
    [
      "# Playwright Upload Probe",
      "",
      `Status: ${status}`,
      `Category: ${category}`,
      "",
      "## Evidence",
      "",
      ...evidence.map((item) => `- ${item}`),
      "",
    ].join("\n"),
  );
  console.log(resultPath);
})();
JS
