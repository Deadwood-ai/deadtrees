import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const eq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));

  return { eq, update, from };
});

vi.mock("../../hooks/useSupabase", () => ({
  supabase: {
    from: supabaseMock.from,
  },
}));

describe("softDeletePriwaKaeferbaum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.eq.mockResolvedValue({ error: null });
  });

  it("sends the RLS-required actor columns when soft deleting", async () => {
    const { softDeletePriwaKaeferbaum } = await import("./usePriwaKaeferbaeume");

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
    expect(supabaseMock.eq).toHaveBeenCalledWith("id", "point-1");
  });
});
