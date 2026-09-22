import { beforeAll, describe, expect, it } from "vitest";
import type { IPriwaPoint } from "./types";
import type { IPriwaQueuedMutation } from "./priwaOfflineStore";

// Opt-in integration against the validated per-worktree QA stack. No mocks,
// migrations, new users or production credentials are used by this test.
describe.skipIf(process.env.PRIWA_LOCAL_TEST !== "1")(
  "PRIWA observation recovery on local Supabase",
  () => {
    let sync: typeof import("./syncPriwaObservation").syncPriwaObservation;
    let client: typeof import("../../hooks/useSupabase").supabase;
    let template: IPriwaPoint;
    const projectId = "00000000-0000-4000-8000-00000000b001";
    const userId = "00000000-0000-4000-8000-00000000a001";

    beforeAll(async () => {
      const { Settings } = await import("../../config");
      const expected = process.env.PRIWA_TEST_SUPABASE_URL;
      if (
        !expected ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(expected) ||
        Settings.SUPABASE_URL !== expected
      ) {
        throw new Error(
          "Refusing PRIWA write test outside the explicitly selected isolated local stack.",
        );
      }
      client = (await import("../../hooks/useSupabase")).supabase;
      const { error } = await client.auth.signInWithPassword({
        email: "qa-contributor-local@example.com",
        password: "DeadTreesQA-Local-1!",
      });
      if (error) throw error;
      const points = await (
        await import("./usePriwaKaeferbaeume")
      ).fetchPriwaKaeferbaeume(projectId);
      template = points[0];
      expect(template).toBeDefined();
      sync = (await import("./syncPriwaObservation")).syncPriwaObservation;
    });

    function createMutation(): IPriwaQueuedMutation {
      const now = new Date().toISOString();
      const point = {
        ...template,
        id: crypto.randomUUID(),
        baumnr: "QA-sync-recovery",
        serverUpdatedAt: undefined,
      };
      return {
        id: crypto.randomUUID(),
        projectId,
        userId,
        pointId: point.id,
        point,
        type: "create",
        queuedAt: now,
        updatedAt: now,
        retryCount: 0,
        status: "pending",
      };
    }

    it("acknowledges a lost response and rejects an obsolete update without overwriting the server", async () => {
      const creation = createMutation();
      const revision = await sync(creation);
      expect(await sync(creation)).toBe(revision);
      const update = {
        ...creation,
        type: "update" as const,
        baseUpdatedAt: revision,
        updatedAt: new Date(Date.now() + 10).toISOString(),
        point: { ...creation.point!, kom: "offline change" },
      };
      const editedRevision = await sync(update);
      const { error } = await client
        .from("priwa_kaeferbaeume")
        .update({ kom: "newer server change" })
        .eq("id", creation.pointId);
      expect(error).toBeNull();
      await expect(
        sync({
          ...update,
          baseUpdatedAt: editedRevision,
          updatedAt: new Date(Date.now() + 20).toISOString(),
        }),
      ).rejects.toThrow("Konflikt");
      const { data } = await client
        .from("priwa_kaeferbaeume")
        .select("kom, updated_at")
        .eq("id", creation.pointId)
        .single();
      expect(data?.kom).toBe("newer server change");
      await sync({
        ...creation,
        type: "delete",
        baseUpdatedAt: data?.updated_at,
        updatedAt: new Date(Date.now() + 30).toISOString(),
      });
    });

    it("syncs pre-upgrade updates and deletes using their old overwrite behavior", async () => {
      const creation = createMutation();
      await sync(creation);
      const { error } = await client
        .from("priwa_kaeferbaeume")
        .update({ kom: "newer server comment" })
        .eq("id", creation.pointId);
      expect(error).toBeNull();
      // Round-trip the old persisted shape: neither revision field is present.
      const legacy: IPriwaQueuedMutation = JSON.parse(
        JSON.stringify({
          ...creation,
          type: "update",
          point: { ...creation.point!, kom: "old offline edit" },
          updatedAt: new Date(Date.now() + 10).toISOString(),
        }),
      );
      expect(legacy.baseUpdatedAt).toBeUndefined();
      expect(legacy.point?.serverUpdatedAt).toBeUndefined();
      await sync(legacy);
      const { data } = await client
        .from("priwa_kaeferbaeume")
        .select("kom")
        .eq("id", creation.pointId)
        .single();
      expect(data?.kom).toBe("old offline edit");
      await sync({
        ...legacy,
        type: "delete",
        point: undefined,
        updatedAt: new Date(Date.now() + 20).toISOString(),
      });
      const remaining = await (
        await import("./usePriwaKaeferbaeume")
      ).fetchPriwaKaeferbaeume(projectId);
      expect(remaining.some((point) => point.id === creation.pointId)).toBe(
        false,
      );
    });

    it.each(["create", "update"] as const)(
      "recovers a lost %s response followed by another local edit",
      async (type) => {
        const { coalescePriwaQueuedMutation } =
          await import("./priwaOfflineSync");
        const creation = createMutation();
        const revision = await sync(creation);
        const attempted =
          type === "create"
            ? creation
            : {
                ...creation,
                type: "update" as const,
                baseUpdatedAt: revision,
                updatedAt: new Date(Date.now() + 10).toISOString(),
                point: { ...creation.point!, kom: "first edit" },
              };
        if (type === "update") await sync(attempted);
        // Server committed, but the device only knows it attempted the write.
        const [next] = coalescePriwaQueuedMutation(
          [
            {
              ...attempted,
              status: "failed",
              retryCount: 1,
              attemptedUpdatedAts: [attempted.updatedAt],
            },
          ],
          {
            ...attempted,
            type: "update",
            status: "pending",
            retryCount: 0,
            updatedAt: new Date(Date.now() + 20).toISOString(),
            point: { ...creation.point!, kom: "second offline edit" },
          },
        );
        await sync(next);
        const { data } = await client
          .from("priwa_kaeferbaeume")
          .select("kom,updated_at")
          .eq("id", creation.pointId)
          .single();
        expect(data?.kom).toBe("second offline edit");
        const deletion = {
          ...next,
          type: "delete" as const,
          baseUpdatedAt: data?.updated_at,
          updatedAt: new Date(Date.now() + 30).toISOString(),
        };
        await sync(deletion);
        await expect(sync(deletion)).resolves.toBeDefined();
      },
    );

    it("does not recreate a missing row from an offline update", async () => {
      const mutation = createMutation();
      await expect(
        sync({
          ...mutation,
          type: "update",
          baseUpdatedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow("Konflikt");
    });
  },
);
