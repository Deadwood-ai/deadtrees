import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("./useSupabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock("./useAuthProvider", () => ({ useAuth: () => ({}) }));

describe("reference patch validation", () => {
  beforeEach(() => rpc.mockReset());

  it("maps a whole-patch status onto the per-layer validation", async () => {
    const { patchStatusValidation } = await import("./useReferencePatches");

    expect(patchStatusValidation("good")).toBe(true);
    expect(patchStatusValidation("bad")).toBe(false);
    expect(patchStatusValidation("pending")).toBeNull();
  });

  it("writes the patch and its ancestors through one RPC", async () => {
    rpc.mockResolvedValue({
      data: { id: 7, dataset_id: 3, deadwood_validated: true, forest_cover_validated: null },
      error: null,
    });
    const { setReferencePatchValidation } = await import("./useReferencePatches");

    const patch = await setReferencePatchValidation({ patchId: 7, layers: ["deadwood"], validated: true });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_reference_patch_validation", {
      p_patch_id: 7,
      p_layers: ["deadwood"],
      p_value: true,
    });
    expect(patch.status).toBe("pending");
  });

  it("surfaces a failed write instead of reporting success", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("Reference patch 7 not found") });
    const { setReferencePatchValidation } = await import("./useReferencePatches");

    await expect(
      setReferencePatchValidation({ patchId: 7, layers: ["deadwood", "forest_cover"], validated: false }),
    ).rejects.toThrow("not found");
  });
});
