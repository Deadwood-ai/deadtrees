import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const order = vi.fn();
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const deleteEq = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn(() => ({ eq: deleteEq }));
  const from = vi.fn(() => ({ select, delete: remove }));
  const rpc = vi.fn();
  return { deleteEq, eq, from, order, remove, rpc, select };
});

vi.mock("../../hooks/useSupabase", () => ({
  supabase: {
    from: supabaseMock.from,
    rpc: supabaseMock.rpc,
  },
}));

describe("PRIWA Befallsgruppen data access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.order.mockResolvedValue({
      data: [
        {
          id: "group-1",
          project_id: "project-1",
          name: "Befallsgruppe 1",
          origin: "suggestion",
          confidence: 0.82,
          suggestion_reason: "Nearby trees",
          algorithm_version: "location-date-v1",
          created_at: "2026-07-16T08:00:00.000Z",
          updated_at: "2026-07-16T09:00:00.000Z",
          priwa_befallsgruppe_members: [
            { tree_id: "tree-1", source: "suggestion" },
          ],
          priwa_befallsgruppe_flights: [
            { dataset_id: 10512, source: "suggestion" },
          ],
        },
      ],
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({ data: "group-1", error: null });
  });

  it("loads nested tree and flight links", async () => {
    const { fetchPriwaBefallsgruppen } =
      await import("./usePriwaBefallsgruppen");

    await expect(fetchPriwaBefallsgruppen("project-1")).resolves.toEqual([
      {
        id: "group-1",
        projectId: "project-1",
        name: "Befallsgruppe 1",
        origin: "suggestion",
        confidence: 0.82,
        suggestionReason: "Nearby trees",
        algorithmVersion: "location-date-v1",
        treeIds: ["tree-1"],
        datasetIds: ["10512"],
        createdAt: "2026-07-16T08:00:00.000Z",
        updatedAt: "2026-07-16T09:00:00.000Z",
      },
    ]);
    expect(supabaseMock.from).toHaveBeenCalledWith("priwa_befallsgruppen");
    expect(supabaseMock.eq).toHaveBeenCalledWith("project_id", "project-1");
  });

  it("saves the complete reviewed group through one atomic RPC", async () => {
    const { savePriwaBefallsgruppe } = await import("./usePriwaBefallsgruppen");

    await savePriwaBefallsgruppe("project-1", {
      id: "group-1",
      name: "Reviewed group",
      origin: "suggestion",
      confidence: 0.82,
      suggestionReason: "Nearby trees",
      algorithmVersion: "location-date-v1",
      treeIds: ["tree-1", "tree-2"],
      datasetIds: ["10512"],
    });

    expect(supabaseMock.rpc).toHaveBeenCalledWith("priwa_save_befallsgruppe", {
      p_project_id: "project-1",
      p_name: "Reviewed group",
      p_tree_ids: ["tree-1", "tree-2"],
      p_dataset_ids: [10512],
      p_group_id: "group-1",
      p_origin: "suggestion",
      p_confidence: 0.82,
      p_suggestion_reason: "Nearby trees",
      p_algorithm_version: "location-date-v1",
    });
  });

  it("rejects non-numeric flight IDs before writing", async () => {
    const { savePriwaBefallsgruppe } = await import("./usePriwaBefallsgruppen");

    await expect(
      savePriwaBefallsgruppe("project-1", {
        name: "Invalid flight",
        origin: "manual",
        treeIds: ["tree-1"],
        datasetIds: ["fallback-id"],
      }),
    ).rejects.toThrow("keine gültige ID");
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});
