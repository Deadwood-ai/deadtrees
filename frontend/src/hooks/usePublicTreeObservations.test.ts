import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const order = vi.fn().mockResolvedValue({ data: [], error: null });
  const select = vi.fn(() => ({ order }));
  const insert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ select, insert }));

  return { from, insert, order, select };
});

vi.mock("./useSupabase", () => ({
  supabase: {
    from: supabaseMock.from,
  },
}));

describe("public tree observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.order.mockResolvedValue({ data: [], error: null });
    supabaseMock.insert.mockResolvedValue({ error: null });
  });

  it("parses point geometry rows into map observations", async () => {
    const { rowToPublicTreeObservation } =
      await import("./usePublicTreeObservations");

    expect(
      rowToPublicTreeObservation({
        id: "observation-1",
        geom: JSON.stringify({
          type: "Point",
          coordinates: [8.68, 50.11],
        }),
        condition: "dead",
        tree_type_group: "conifer",
        tree_type_text: "Spruce",
        comment: "Brown crown",
        created_at: "2026-06-10T10:00:00.000Z",
      }),
    ).toEqual({
      id: "observation-1",
      lat: 50.11,
      lon: 8.68,
      condition: "dead",
      treeTypeGroup: "conifer",
      treeTypeText: "Spruce",
      comment: "Brown crown",
      clientId: null,
      createdAt: "2026-06-10T10:00:00.000Z",
    });
  });

  it("inserts only constrained public observation fields", async () => {
    const { insertPublicTreeObservation } =
      await import("./usePublicTreeObservations");

    await insertPublicTreeObservation({
      lat: 50.11,
      lon: 8.68,
      condition: "declining",
      treeTypeGroup: "broadleaf",
      treeTypeText: "  Oak  ",
      comment: "  Partly dead crown  ",
      clientId: "client-1",
    });

    expect(supabaseMock.from).toHaveBeenCalledWith("public_tree_observations");
    expect(supabaseMock.insert).toHaveBeenCalledWith({
      geom: {
        type: "Point",
        coordinates: [8.68, 50.11],
      },
      condition: "declining",
      tree_type_group: "broadleaf",
      tree_type_text: "Oak",
      comment: "Partly dead crown",
      client_id: "client-1",
    });
  });
});
