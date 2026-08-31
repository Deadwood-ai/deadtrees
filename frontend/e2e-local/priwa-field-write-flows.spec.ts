import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "http://127.0.0.1:54321";

const uniqueRunId = `${Date.now()}-${randomUUID()}`;
const fieldUserEmail = `priwa-write-${uniqueRunId}@example.com`;
const fieldUserPassword = `Priwa-${uniqueRunId}!`;
const projectSlug = `priwa-e2e-${uniqueRunId}`;
const projectName = "PRIWA Local E2E";
const baumnr = `E2E-${uniqueRunId.slice(-12)}`;
const updatedBaumnr = `${baumnr}-U`;
const stalledSyncBaumnr = `${baumnr}-S1`;
const queuedDuringSyncBaumnr = `${baumnr}-S2`;
const deletedDuringSyncBaumnr = `${baumnr}-S3`;
const staleCompletionBaumnr = `${baumnr}-STALE`;
const newerCompletionBaumnr = `${baumnr}-NEWER`;

let adminClient: SupabaseClient;
let fieldUserId = "";
let projectId = "";

test.describe("PRIWA local field write flows", () => {
  test.skip(
    process.env.E2E_LOCAL_PRIWA_WRITE !== "1",
    "Set E2E_LOCAL_PRIWA_WRITE=1 and start local Supabase before running this write suite.",
  );

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    adminClient = createLocalSupabaseClient(
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    );

    await expectLocalService(
      `${localSupabaseUrl}/auth/v1/settings`,
      "local Supabase",
    );
    await deleteAuthUsersByEmail(adminClient, fieldUserEmail);

    const user = await createConfirmedUser(fieldUserEmail, fieldUserPassword);
    fieldUserId = user.id;
    projectId = await createPriwaProjectWithMembership(fieldUserId);
  });

  test.afterAll(async () => {
    if (projectId) {
      await adminClient
        .from("priwa_kaeferbaeume")
        .delete()
        .eq("project_id", projectId);
      await adminClient
        .from("priwa_project_memberships")
        .delete()
        .eq("project_id", projectId);
      await adminClient.from("priwa_projects").delete().eq("id", projectId);
    }

    await deleteAuthUsersByEmail(adminClient, fieldUserEmail);
  });

  test("mobile field controls keep map actions compact and the form open", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await signInFieldUser(page);
    const fieldMap = page.getByTestId("priwa-field-map");
    await expect(fieldMap).toBeVisible();
    const viewportCoverage = await fieldMap.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        documentHeight: document.documentElement.scrollHeight,
        top: bounds.top,
        viewportHeight: window.innerHeight,
      };
    });
    expect(viewportCoverage.top).toBeLessThanOrEqual(0);
    expect(viewportCoverage.bottom).toBeGreaterThanOrEqual(
      viewportCoverage.viewportHeight,
    );
    expect(viewportCoverage.documentHeight).toBeLessThanOrEqual(
      viewportCoverage.viewportHeight,
    );
    await expect(
      page.getByText("Standort-Button antippen", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Offline nur im Build", { exact: true }),
    ).toHaveCount(0);

    await expect(
      page.getByRole("button", { name: "Zu Karte wechseln" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Baumliste öffnen" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Punkt aufnehmen" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "PRIWA Feldaktionen" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Punkt aufnehmen" }).click();
    const captureDrawer = page.locator(
      ".priwa-point-drawer-root .ant-drawer-content-wrapper",
    );
    await expect(captureDrawer).toHaveCSS(
      "height",
      `${page.viewportSize()!.height}px`,
    );
    await expect(page.getByLabel("Bohrmehl")).toBeVisible();
    const comment = page.getByLabel("Kommentar");
    await expect(comment).toBeVisible();
    await comment.fill("Bleibt beim Drehen erhalten");
    await page.setViewportSize({ width: 820, height: 852 });
    await expect(comment).toHaveValue("Bleibt beim Drehen erhalten");
  });

  test("offline create, update, and delete sync into local Supabase", async ({
    context,
    page,
  }) => {
    await signInFieldUser(page);
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Befliegung/ }),
    ).toBeVisible();
    await expectOfflineBasemapControl(page);
    await page.evaluate(() => {
      window.localStorage.setItem(
        "deadtrees-priwa-field:observer-name",
        "Stefan Treyer",
      );
    });

    await context.setOffline(true);
    await waitForBrowserOnlineState(page, false);

    await createMapEstimatedPoint(page, baumnr);
    await expect(page.getByText(/1 ausstehend|Synchronisiert/i)).toBeVisible();

    await context.setOffline(false);
    await waitForBrowserOnlineState(page, true);
    const createdRow = await waitForPointRow(
      baumnr,
      (row) => row.deleted_at === null,
    );
    expect(createdRow.name).toBe("Stefan Treyer");
    expect(createdRow.gruene_nadeln_am_boden).toBe("nein");
    await expect(
      page.getByText(/Synchronisiert\.\.\.|ausstehend|Sync Fehler/i),
    ).toHaveCount(0);
    await expectResizableDesktopPointTable(page);

    await context.setOffline(true);
    await editFirstPointBaumnr(page, updatedBaumnr);
    await expect(page.getByText(/1 ausstehend|Synchronisiert/i)).toBeVisible();

    await context.setOffline(false);
    await waitForBrowserOnlineState(page, true);
    await waitForPointRow(updatedBaumnr, (row) => row.deleted_at === null);
    await expect(
      page.getByText(/Synchronisiert\.\.\.|ausstehend|Sync Fehler/i),
    ).toHaveCount(0);

    await context.setOffline(true);
    await deleteFirstPoint(page);
    await expect(page.getByText(/1 ausstehend|Synchronisiert/i)).toBeVisible();

    await context.setOffline(false);
    await waitForBrowserOnlineState(page, true);
    const deletedRow = await waitForPointRow(updatedBaumnr, (row) => {
      return row.deleted_at !== null && row.deleted_by === fieldUserId;
    });
    expect(deletedRow.updated_by).toBe(fieldUserId);
  });

  test("keeps accepting local captures while a sync request is stalled", async ({
    page,
  }) => {
    await signInFieldUser(page);
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();

    let releaseMutation: () => void = () => undefined;
    const stalledMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let shouldStallMutation = true;
    const routePattern = "**/rest/v1/priwa_kaeferbaeume**";
    await page.route(routePattern, async (route) => {
      if (
        shouldStallMutation &&
        ["POST", "PATCH"].includes(route.request().method())
      ) {
        await stalledMutation;
      }
      await route.continue();
    });

    await createMapEstimatedPoint(page, stalledSyncBaumnr);
    await expect(
      page.getByText("Synchronisiert...", { exact: true }),
    ).toBeVisible();

    const secondPage = await page.context().newPage();
    await secondPage.goto("/priwa-field");
    await expect(secondPage.getByTestId("priwa-field-map")).toBeVisible();
    await expect(
      secondPage.getByText("Synchronisiert...", { exact: true }),
    ).toBeVisible();
    const { data: rowsBeforeRelease, error: rowsBeforeReleaseError } =
      await adminClient
        .from("priwa_kaeferbaeume")
        .select("id")
        .eq("project_id", projectId)
        .eq("baumnr", stalledSyncBaumnr);
    expect(rowsBeforeReleaseError).toBeNull();
    expect(rowsBeforeRelease).toEqual([]);

    await createMapEstimatedPoint(secondPage, queuedDuringSyncBaumnr);

    shouldStallMutation = false;
    releaseMutation();
    await waitForPointRow(stalledSyncBaumnr, (row) => row.deleted_at === null);
    await waitForPointRow(
      queuedDuringSyncBaumnr,
      (row) => row.deleted_at === null,
    );
    await expect(
      page.getByText(/Synchronisiert\.\.\.|ausstehend|Sync Fehler/i),
    ).toHaveCount(0);
    await secondPage.close();
    await page.unroute(routePattern);
  });

  test("retains a delete issued while its create request is stalled", async ({
    page,
  }) => {
    await signInFieldUser(page);
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();

    let releaseMutation: () => void = () => undefined;
    const stalledMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const routePattern = "**/rest/v1/priwa_kaeferbaeume**";
    await page.route(routePattern, async (route) => {
      if (["POST", "PATCH"].includes(route.request().method())) {
        await stalledMutation;
      }
      await route.continue();
    });

    await createMapEstimatedPoint(page, deletedDuringSyncBaumnr);
    await expect(
      page.getByText("Synchronisiert...", { exact: true }),
    ).toBeVisible();
    await deleteFirstPoint(page);

    releaseMutation();
    await waitForPointRow(
      deletedDuringSyncBaumnr,
      (row) => row.deleted_at !== null,
    );
    await expect(
      page.getByText(/Synchronisiert\.\.\.|ausstehend|Sync Fehler/i),
    ).toHaveCount(0);
    await page.unroute(routePattern);
  });

  test("does not let a stale server completion overwrite a newer mutation", async () => {
    const pointId = randomUUID();
    const olderClientTimestamp = "2026-08-31T12:00:00.000Z";
    const newerClientTimestamp = "2026-08-31T12:01:00.000Z";
    const baseRow = {
      id: pointId,
      project_id: projectId,
      geom: { type: "Point", coordinates: [8.18, 48.456] },
      location_source: "map_estimated",
      baumnr: newerCompletionBaumnr,
      fund: "ja",
      baumart: "Fichte",
      bm: "ja",
      bohrloch: "ja",
      harz: "nein",
      gruene_nadeln_am_boden: "nein",
      nadel: "grün",
      rinde: "0%",
      kv: "0%",
      name: "PRIWA E2E",
      datum: "2026-08-31",
      created_by: fieldUserId,
      updated_by: fieldUserId,
      client_updated_at: newerClientTimestamp,
    };

    const { error: newerWriteError } = await adminClient
      .from("priwa_kaeferbaeume")
      .upsert(baseRow, { onConflict: "id" });
    expect(newerWriteError).toBeNull();

    const { error: staleWriteError } = await adminClient
      .from("priwa_kaeferbaeume")
      .upsert(
        {
          ...baseRow,
          baumnr: staleCompletionBaumnr,
          client_updated_at: olderClientTimestamp,
        },
        { onConflict: "id" },
      );
    expect(staleWriteError).toBeNull();

    const { data: persistedRow, error: persistedRowError } = await adminClient
      .from("priwa_kaeferbaeume")
      .select("baumnr, client_updated_at")
      .eq("id", pointId)
      .single();
    expect(persistedRowError).toBeNull();
    expect(persistedRow?.baumnr).toBe(newerCompletionBaumnr);
    expect(new Date(persistedRow!.client_updated_at).toISOString()).toBe(
      newerClientTimestamp,
    );

    const { error: nullTimestampError } = await adminClient
      .from("priwa_kaeferbaeume")
      .update({
        baumnr: `${newerCompletionBaumnr}-NULL-BYPASS`,
        client_updated_at: null,
      })
      .eq("id", pointId);
    expect(nullTimestampError).not.toBeNull();
    const { data: rowAfterNullTimestamp, error: nullTimestampReadError } =
      await adminClient
        .from("priwa_kaeferbaeume")
        .select("baumnr, client_updated_at")
        .eq("id", pointId)
        .single();
    expect(nullTimestampReadError).toBeNull();
    expect(rowAfterNullTimestamp?.baumnr).toBe(newerCompletionBaumnr);
    expect(
      new Date(rowAfterNullTimestamp!.client_updated_at).toISOString(),
    ).toBe(newerClientTimestamp);

    const deletedClientTimestamp = "2026-08-31T12:02:00.000Z";
    const resurrectionTimestamp = "2026-08-31T12:03:00.000Z";
    const { error: deleteError } = await adminClient
      .from("priwa_kaeferbaeume")
      .update({
        deleted_at: deletedClientTimestamp,
        deleted_by: fieldUserId,
        client_updated_at: deletedClientTimestamp,
      })
      .eq("id", pointId);
    expect(deleteError).toBeNull();

    const { error: resurrectionError } = await adminClient
      .from("priwa_kaeferbaeume")
      .upsert(
        {
          ...baseRow,
          baumnr: `${newerCompletionBaumnr}-RESURRECTED`,
          deleted_at: null,
          deleted_by: null,
          client_updated_at: resurrectionTimestamp,
        },
        { onConflict: "id" },
      );
    expect(resurrectionError).toBeNull();

    const { data: deletedRow, error: deletedRowError } = await adminClient
      .from("priwa_kaeferbaeume")
      .select("baumnr, deleted_at, client_updated_at")
      .eq("id", pointId)
      .single();
    expect(deletedRowError).toBeNull();
    expect(deletedRow?.baumnr).toBe(newerCompletionBaumnr);
    expect(new Date(deletedRow!.deleted_at).toISOString()).toBe(
      deletedClientTimestamp,
    );
    expect(new Date(deletedRow!.client_updated_at).toISOString()).toBe(
      deletedClientTimestamp,
    );
  });
});

async function createMapEstimatedPoint(page: Page, pointBaumnr: string) {
  await page.getByRole("button", { name: "Punkt aufnehmen" }).click();
  await expect(page.getByText("Käferbaum aufnehmen")).toBeVisible();

  await page.getByRole("button", { name: "Auf Karte setzen" }).click();
  await page.getByRole("button", { name: "Punkt übernehmen" }).click();
  await expect(
    page.getByText("Auf Karte gesetzt", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Geschätzt", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Auf Karte setzen" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectCommentCounterClearOfSaveButton(page);

  await page.getByLabel("Baumnr").fill(pointBaumnr);
  await page.getByRole("button", { name: "Schnellspeichern" }).click();
  await expect(page.getByText("Käferbaum gespeichert")).toBeVisible();
}

async function expectCommentCounterClearOfSaveButton(page: Page) {
  await page.getByRole("button", { name: "Kommentar" }).click();
  await expect(page.getByLabel("Kommentar")).toBeVisible();
  await page.getByLabel("Kommentar").scrollIntoViewIfNeeded();

  const counter = page.locator(
    ".priwa-comment-form-item .ant-input-data-count",
  );
  const saveButton = page.getByRole("button", { name: "Schnellspeichern" });

  await expect(counter).toBeVisible();
  await expect(saveButton).toBeVisible();

  await expect
    .poll(async () => {
      const counterBox = await counter.boundingBox();
      const saveButtonBox = await saveButton.boundingBox();

      if (!counterBox || !saveButtonBox) return Number.NEGATIVE_INFINITY;
      return saveButtonBox.y - (counterBox.y + counterBox.height);
    })
    .toBeGreaterThan(0);
}

async function expectOfflineBasemapControl(page: Page) {
  await page.getByRole("button", { name: "Zu Karte wechseln" }).click();
  await expect(
    page.getByRole("button", { name: "Zu Luftbild wechseln" }),
  ).toBeVisible();
  await expect(page.locator(".ol-layer").first()).toBeVisible();

  await page.getByRole("button", { name: "Offline-Karten speichern" }).click();
  await expect(page.getByText("Offline-Karten")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ausschnitt + Umgebung speichern" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
}

async function expectResizableDesktopPointTable(page: Page) {
  await page.getByRole("button", { name: "Punktliste öffnen" }).click();

  const panel = page.getByTestId("priwa-point-list-panel");
  const resizeHandle = page.getByRole("separator", {
    name: "Tabellenbreite ändern",
  });
  const tableBody = panel.locator(".ant-table-body");
  await expect(panel).toBeVisible();
  await expect(resizeHandle).toBeVisible();
  await expect(panel.locator(".ant-table-sticky-holder")).toBeVisible();
  await expect(tableBody).toBeVisible();
  expect(
    await tableBody.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);

  const initialWidth = await panel.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(initialWidth).toBeLessThanOrEqual(page.viewportSize()!.width - 30);

  await resizeHandle.press("ArrowLeft");
  await expect
    .poll(() =>
      panel.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeLessThan(initialWidth);

  const widthBeforeDrag = await panel.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox!.x - 64,
    handleBox!.y + handleBox!.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      panel.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeLessThan(widthBeforeDrag);
  expect(
    await panel.evaluate((element) => element.getBoundingClientRect().right),
  ).toBeLessThan(page.viewportSize()!.width - 80);

  await page.getByRole("button", { name: "Schließen" }).click();
  await expect(panel).toBeHidden();
}

async function editFirstPointBaumnr(page: Page, pointBaumnr: string) {
  await page.getByRole("button", { name: "Punktliste öffnen" }).click();
  await page.getByRole("button", { name: "Punkt bearbeiten" }).first().click();
  await expect(page.getByText("Käferbaum bearbeiten")).toBeVisible();
  await expect(
    page.getByText("Auf Karte gesetzt", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Geschätzt", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Auf Karte setzen" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Baumnr").fill(pointBaumnr);
  await page.getByRole("button", { name: "Aktualisieren" }).click();
  await expect(page.getByText("Käferbaum aktualisiert")).toBeVisible();
}

async function deleteFirstPoint(page: Page) {
  await page.getByRole("button", { name: "Punktliste öffnen" }).click();
  await page.getByRole("button", { name: "Punkt bearbeiten" }).first().click();
  await expect(page.getByText("Käferbaum bearbeiten")).toBeVisible();

  await page.getByRole("button", { name: "Löschen" }).click();
  await page
    .getByRole("dialog", { name: "Käferbaum löschen?" })
    .getByRole("button", { name: "Löschen" })
    .click();
  await expect(page.getByText("Käferbaum gelöscht")).toBeVisible();
}

async function signInFieldUser(page: Page) {
  await page.goto("/sign-in?returnTo=/priwa-field");
  await page.getByPlaceholder(/email/i).fill(fieldUserEmail);
  await page.getByPlaceholder(/password/i).fill(fieldUserPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/priwa-field$/, { timeout: 20_000 });
}

async function waitForBrowserOnlineState(page: Page, expectedOnline: boolean) {
  await page.waitForFunction(
    (online) => window.navigator.onLine === online,
    expectedOnline,
  );
}

async function createPriwaProjectWithMembership(userId: string) {
  const { data: project, error: projectError } = await adminClient
    .from("priwa_projects")
    .insert({
      slug: projectSlug,
      name: projectName,
    })
    .select("id")
    .single();

  if (projectError || !project) {
    throw projectError ?? new Error("Failed to create local PRIWA project");
  }

  const { error: membershipError } = await adminClient
    .from("priwa_project_memberships")
    .insert({
      project_id: project.id,
      user_id: userId,
      role: "field_user",
    });

  if (membershipError) {
    throw membershipError;
  }

  return project.id as string;
}

async function waitForPointRow(
  expectedBaumnr: string,
  predicate: (row: IPriwaPointRow) => boolean,
) {
  const deadline = Date.now() + 20_000;
  let lastRows: IPriwaPointRow[] | null = null;

  while (Date.now() < deadline) {
    const { data, error } = await adminClient
      .from("priwa_kaeferbaeume")
      .select(
        "id, baumnr, name, gruene_nadeln_am_boden, deleted_at, deleted_by, updated_by",
      )
      .eq("project_id", projectId)
      .eq("baumnr", expectedBaumnr)
      .order("updated_at", { ascending: false });

    expect(error).toBeNull();
    lastRows = (data ?? []) as IPriwaPointRow[];
    const matchingRow = lastRows.find(predicate);
    if (matchingRow) {
      return matchingRow;
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for PRIWA point ${expectedBaumnr}; last rows: ${JSON.stringify(lastRows)}`,
  );
}

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
    throw new Error(`${name} must be set for the local PRIWA write E2E suite.`);
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

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type IPriwaPointRow = {
  id: string;
  baumnr: string;
  name: string;
  gruene_nadeln_am_boden: string;
  deleted_at: string | null;
  deleted_by: string | null;
  updated_by: string | null;
};
