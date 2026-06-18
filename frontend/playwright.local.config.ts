import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT || 5173);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;
const SLOW_MO = Number(process.env.PLAYWRIGHT_SLOW_MO || 0);
const ISOLATED_ENV_FILE = process.env.DEADTREES_ISOLATED_ENV_FILE;
const ISOLATED_ENV_SNIPPET = ISOLATED_ENV_FILE
  ? `if [ -f ${JSON.stringify(ISOLATED_ENV_FILE)} ]; then set -a; source ${JSON.stringify(ISOLATED_ENV_FILE)}; set +a; fi; `
  : "if [ -f ../.local/supabase/current.env ]; then set -a; source ../.local/supabase/current.env; set +a; fi; ";

export default defineConfig({
  testDir: "./e2e-local",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    launchOptions: {
      slowMo: SLOW_MO,
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command:
      "bash -lc 'if [ -f .env.dev.local ]; then set -a; source .env.dev.local; set +a; fi; " +
      ISOLATED_ENV_SNIPPET +
      "export VITE_MODE=development; npm run dev -- --host 127.0.0.1 --port " +
      PORT +
      "'",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
