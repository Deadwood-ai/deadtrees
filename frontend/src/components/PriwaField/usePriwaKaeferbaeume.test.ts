import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const order = vi.fn().mockResolvedValue({ data: [], error: null });
  const is = vi.fn(() => ({ order }));
  const selectEq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq: selectEq }));
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq: updateEq }));
  const from = vi.fn(() => ({ select, update }));

  return { from, is, order, select, selectEq, update, updateEq };
});

vi.mock("../../hooks/useSupabase", () => ({
  supabase: {
    from: supabaseMock.from,
  },
}));

describe("softDeletePriwaKaeferbaum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.order.mockResolvedValue({ data: [], error: null });
    supabaseMock.updateEq.mockResolvedValue({ error: null });
  });

  it("fetches only current-state PRIWA rows", async () => {
    const { fetchPriwaKaeferbaeume } = await import("./usePriwaKaeferbaeume");

    await fetchPriwaKaeferbaeume("project-1");

    expect(supabaseMock.from).toHaveBeenCalledWith("priwa_kaeferbaeume");
    expect(supabaseMock.select).toHaveBeenCalledWith(
      expect.stringContaining("gruene_nadeln_am_boden"),
    );
    expect(supabaseMock.selectEq).toHaveBeenCalledWith(
      "project_id",
      "project-1",
    );
    expect(supabaseMock.is).toHaveBeenCalledWith("deleted_at", null);
    expect(supabaseMock.order).toHaveBeenCalledWith("updated_at", {
      ascending: false,
    });
  });

  it("sends the RLS-required actor columns when soft deleting", async () => {
    const { softDeletePriwaKaeferbaum } =
      await import("./usePriwaKaeferbaeume");

    await softDeletePriwaKaeferbaum(
      "point-1",
      "user-1",
      "2026-05-20T07:15:00.000Z",
    );

    expect(supabaseMock.from).toHaveBeenCalledWith("priwa_kaeferbaeume");
    expect(supabaseMock.update).toHaveBeenCalledWith({
      deleted_at: "2026-05-20T07:15:00.000Z",
      deleted_by: "user-1",
      updated_by: "user-1",
      client_updated_at: "2026-05-20T07:15:00.000Z",
    });
    expect(supabaseMock.updateEq).toHaveBeenCalledWith("id", "point-1");
  });
});
