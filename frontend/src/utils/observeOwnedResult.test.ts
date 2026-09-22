import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  rpc: vi.fn().mockResolvedValue({ error: null }),
  has_opted_in_capturing: vi.fn(() => false),
  has_opted_out_capturing: vi.fn(() => false),
}));
vi.mock("../hooks/useSupabase", () => ({ supabase: { rpc: boundary.rpc } }));
vi.mock("posthog-js", () => ({ default: boundary }));
import { observeOwnedResult } from "./observeOwnedResult";

const dataset = { id: 42, user_id: "owner", is_combined_model_done: true, is_deadwood_done: false, is_forest_cover_done: false };
beforeEach(() => {
  vi.clearAllMocks();
  boundary.has_opted_in_capturing.mockReturnValue(false);
  boundary.rpc.mockResolvedValue({ error: null });
});

describe("consented owner result observations", () => {
  it("sends nothing before analytics consent", async () => {
    await observeOwnedResult(dataset, "owner");
    expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it("does not count anonymous visitors or other users", async () => {
    boundary.has_opted_in_capturing.mockReturnValue(true);
    await observeOwnedResult(dataset, undefined);
    await observeOwnedResult(dataset, "operator");
    expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it("requires prediction outputs and supports the combined model", async () => {
    boundary.has_opted_in_capturing.mockReturnValue(true);
    await observeOwnedResult({ ...dataset, is_combined_model_done: false }, "owner");
    expect(boundary.rpc).not.toHaveBeenCalled();
    await observeOwnedResult(dataset, "owner");
    expect(boundary.rpc).toHaveBeenCalledWith("factory_record_result_view", { p_dataset_id: 42 });
  });
  it("keeps optional telemetry failures out of the viewing flow", async () => {
    boundary.has_opted_in_capturing.mockReturnValue(true);
    boundary.rpc.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(observeOwnedResult(dataset, "owner")).resolves.toBeUndefined();
    expect(boundary.rpc).toHaveBeenCalledTimes(1);
  });
});
