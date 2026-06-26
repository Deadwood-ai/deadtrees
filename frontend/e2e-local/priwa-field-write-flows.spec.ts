import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const localSupabaseUrl =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";

const uniqueRunId = `${Date.now()}-${randomUUID()}`;
const fieldUserEmail = `priwa-write-${uniqueRunId}@example.com`;
const fieldUserPassword = `Priwa-${uniqueRunId}!`;
const projectSlug = `priwa-e2e-${uniqueRunId}`;
const projectName = "PRIWA Local E2E";
const baumnr = `E2E-${uniqueRunId.slice(-12)}`;
const updatedBaumnr = `${baumnr}-U`;

let adminClient: SupabaseClient;
let fieldUserId = "";
let projectId = "";
let mosaicDatasetId: number | null = null;

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
    mosaicDatasetId = await createPriwaDatasetCog(fieldUserId);
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

    if (mosaicDatasetId !== null) {
      await adminClient.from("v2_datasets").delete().eq("id", mosaicDatasetId);
    }

    await deleteAuthUsersByEmail(adminClient, fieldUserEmail);
  });

  test("offline create, update, and delete sync into local Supabase", async ({
    context,
    page,
  }) => {
    await signInFieldUser(page);
    await expect(page.getByTestId("priwa-field-map")).toBeVisible();
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

    await context.setOffline(true);
    await editFirstPointBaumnr(page, updatedBaumnr);
    await expect(page.getByText(/1 ausstehend|Synchronisiert/i)).toBeVisible();

    await context.setOffline(false);
    await waitForBrowserOnlineState(page, true);
    await waitForPointRow(updatedBaumnr, (row) => row.deleted_at === null);

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
});

async function createMapEstimatedPoint(page: Page, pointBaumnr: string) {
  await page.getByRole("button", { name: "Punkt aufnehmen" }).click();
  await expect(page.getByText("Käferbaum aufnehmen")).toBeVisible();

  await page.getByRole("button", { name: "Auf Karte setzen" }).click();
  await page.getByRole("button", { name: "Punkt übernehmen" }).click();
  await expect(page.getByText("Position gesetzt")).toBeVisible();
  await expectCommentCounterClearOfSaveButton(page);

  await page.getByLabel("Baumnr").fill(pointBaumnr);
  await page.getByRole("button", { name: "Schnellspeichern" }).click();
  await expect(page.getByText("Käferbaum gespeichert")).toBeVisible();
}

async function expectCommentCounterClearOfSaveButton(page: Page) {
  await page.getByLabel("Kommentar").scrollIntoViewIfNeeded();

  const counter = page.locator(
    ".priwa-comment-form-item .ant-input-data-count",
  );
  const saveButton = page.getByRole("button", { name: "Schnellspeichern" });

  await expect(counter).toBeVisible();
  await expect(saveButton).toBeVisible();

  const counterBox = await counter.boundingBox();
  const saveButtonBox = await saveButton.boundingBox();

  expect(counterBox).not.toBeNull();
  expect(saveButtonBox).not.toBeNull();
  expect(counterBox!.y + counterBox!.height).toBeLessThan(saveButtonBox!.y);
}

async function expectOfflineBasemapControl(page: Page) {
  await page.getByRole("button", { name: "Layer auswählen" }).click();
  await expect(page.getByText("Kartenbasis")).toBeVisible();
  await expect(page.getByText("Luftbild", { exact: true })).toBeVisible();
  await expect(page.getByText("1 Befliegung")).toBeVisible();
  await page.getByText("Karte", { exact: true }).click();
  await expect(page.locator(".ol-layer").first()).toBeVisible();
  await expect(page.getByText("Offline-Karten")).toBeHidden();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Offline-Karten speichern" }).click();
  await expect(page.getByText("Offline-Karten")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ausschnitt + Umgebung speichern" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
}

async function editFirstPointBaumnr(page: Page, pointBaumnr: string) {
  await page.getByRole("button", { name: "Punktliste öffnen" }).click();
  await page.getByRole("button", { name: "Punkt bearbeiten" }).first().click();
  await expect(page.getByText("Käferbaum bearbeiten")).toBeVisible();

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

async function createPriwaDatasetCog(userId: string) {
  const { data: dataset, error: datasetError } = await adminClient
    .from("v2_datasets")
    .insert({
      user_id: userId,
      file_name: "priwa-e2e-test-flight.tif",
      license: "CC BY",
      platform: "drone",
      authors: ["PRIWA E2E"],
      aquisition_year: 2026,
      aquisition_month: 6,
      aquisition_day: 24,
      additional_information: "PRIWA local E2E test flight.",
      data_access: "public",
      archived: false,
    })
    .select("id")
    .single();

  if (datasetError || !dataset) {
    throw datasetError ?? new Error("Failed to create local PRIWA dataset");
  }

  const datasetId = dataset.id as number;
  const { error: statusError } = await adminClient.from("v2_statuses").insert({
    dataset_id: datasetId,
    current_status: "idle",
    is_upload_done: true,
    is_ortho_done: true,
    is_cog_done: true,
    is_thumbnail_done: false,
    is_deadwood_done: false,
    is_forest_cover_done: false,
    is_metadata_done: true,
    has_error: false,
    error_message: null,
  });

  if (statusError) throw statusError;

  const { error: cogError } = await adminClient.from("v2_cogs").insert({
    dataset_id: datasetId,
    cog_file_name: "priwa-e2e-test-flight-cog.tif",
    version: 1,
    cog_info: {},
    cog_processing_runtime: 0.1,
    cog_path: "priwa/e2e/test-flight.tif",
    cog_file_size: 234567,
  });

  if (cogError) throw cogError;

  return datasetId;
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
