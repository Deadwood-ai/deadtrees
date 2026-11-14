import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const localDataRoot = process.env.LOCAL_DATA_ROOT || path.join(repoRoot, "data");
const rgbGeoTiffFixture = path.resolve(__dirname, "../../test/fixtures/geotiff/upload-validation/rgb-real-crop.tif");
const localSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:54321";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the local editor write suite.`);
  return value;
}

function localClient(key: string): SupabaseClient {
  return createClient(localSupabaseUrl, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * One auditor and one public dataset with a deadwood prediction, created in the local stack
 * for editor tests and removed again afterwards. Local only: never point it at production.
 */
export function createAuditEditorFixture(label: string) {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const email = `${label}-${runId}@example.com`;
  const password = `Editor-${runId}!`;
  const cogPath = `${label}/${runId}.tif`;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let userId = "";
  let privilegeId = 0;
  let datasetId = 0;

  async function deleteRows(table: string, column: string, value: number | string) {
    const { error } = await admin.from(table).delete().eq(column, value);
    if (error) throw new Error(`Failed to clean ${table}.${column}=${String(value)}: ${error.message}`);
  }

  return {
    get datasetId() {
      return datasetId;
    },

    async setup() {
      admin = localClient(requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
      anon = localClient(process.env.VITE_SUPABASE_ANON_KEY || requireEnv("SUPABASE_ANON_KEY"));
      const { data: created, error: userError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      expect(userError).toBeNull();
      userId = created.user!.id;

      const privilege = await admin
        .from("privileged_users")
        .insert({ user_id: userId, can_upload_private: false, can_view_all_private: false, can_audit: true })
        .select("id")
        .single();
      expect(privilege.error).toBeNull();
      privilegeId = privilege.data!.id as number;

      const dataset = await admin
        .from("v2_datasets")
        .insert({
          file_name: `${label}-${runId}.tif`,
          user_id: userId,
          license: "CC BY",
          platform: "drone",
          authors: ["Local Editor Test"],
          data_access: "public",
          aquisition_year: 2024,
          aquisition_month: 6,
          aquisition_day: 1,
        })
        .select("id")
        .single();
      expect(dataset.error).toBeNull();
      datasetId = dataset.data!.id as number;

      const status = await admin.from("v2_statuses").insert({
        dataset_id: datasetId,
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
      expect(status.error).toBeNull();

      const cogFile = path.join(localDataRoot, "cogs", cogPath);
      fs.mkdirSync(path.dirname(cogFile), { recursive: true });
      fs.copyFileSync(rgbGeoTiffFixture, cogFile);
      const cog = await admin.from("v2_cogs").insert({
        dataset_id: datasetId,
        cog_file_name: path.basename(cogPath),
        version: 1,
        cog_file_size: fs.statSync(cogFile).size,
        cog_info: {},
        cog_processing_runtime: 0.1,
        cog_path: cogPath,
      });
      expect(cog.error).toBeNull();

      const preference = await admin.from("v2_model_preferences").select("model_config").eq("label_data", "deadwood").single();
      expect(preference.error).toBeNull();
      const prediction = await admin.from("v2_labels").insert({
        dataset_id: datasetId,
        user_id: userId,
        label_source: "model_prediction",
        label_type: "semantic_segmentation",
        label_data: "deadwood",
        model_config: preference.data!.model_config,
      });
      expect(prediction.error).toBeNull();
    },

    async teardown() {
      if (!admin) return;
      if (datasetId) {
        for (const table of [
          "dataset_audit_locks",
          "dataset_audit",
          "v2_aois",
          "v2_geometry_corrections",
          "v2_labels",
          "v2_cogs",
          "v2_statuses",
        ]) {
          await deleteRows(table, "dataset_id", datasetId);
        }
        await deleteRows("v2_datasets", "id", datasetId);
      }
      if (privilegeId) await deleteRows("privileged_users", "id", privilegeId);
      if (userId) await admin.auth.admin.deleteUser(userId);
      fs.rmSync(path.join(localDataRoot, "cogs", cogPath), { force: true });
    },

    /** Signs the auditor in, opens the dataset's audit view and starts the deadwood editor. */
    async openDeadwoodEditor(page: Page) {
      const login = await anon.auth.signInWithPassword({ email, password });
      expect(login.error).toBeNull();
      await page.addInitScript((session) => {
        window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
      }, login.data.session);
      await page.goto(`/dataset-audit/${datasetId}`);
      await page.getByRole("button", { name: "Accept" }).click({ timeout: 2_000 }).catch(() => undefined);
      // A previous test's page may still hold this auditor's lease.
      const continueHere = page.getByRole("button", { name: "Continue here" });
      const editDeadwood = page.getByRole("button", { name: "Edit deadwood cover" });
      await expect(editDeadwood.or(continueHere).first()).toBeVisible({ timeout: 20_000 });
      if (await continueHere.isVisible()) await continueHere.click();
      await editDeadwood.click();
      await expect(page.getByText("Editing deadwood cover", { exact: true })).toBeVisible();
    },

    async countCorrections(operation: string): Promise<number> {
      const { count, error } = await admin
        .from("v2_geometry_corrections")
        .select("id", { count: "exact", head: true })
        .eq("dataset_id", datasetId)
        .eq("operation", operation);
      expect(error).toBeNull();
      return count ?? 0;
    },
  };
}
