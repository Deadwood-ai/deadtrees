import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IPriwaPoint } from "./types";

const supabaseMock = vi.hoisted(() => {
  const order = vi.fn().mockResolvedValue({ data: [], error: null });
  const is = vi.fn(() => ({ order }));
  const selectEq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq: selectEq }));
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq: updateEq }));
  const upsertAbortSignal = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn(() => ({ abortSignal: upsertAbortSignal }));
  const from = vi.fn(() => ({ select, update, upsert }));

  return {
    from,
    is,
    order,
    select,
    selectEq,
    update,
    updateEq,
    upsert,
    upsertAbortSignal,
  };
});

const basePoint: IPriwaPoint = {
  id: "point-1",
  lat: 48.456,
  lon: 8.18,
  baumnr: "42",
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "Sigi Huber",
  datum: "2026-05-19",
  kom: "",
  capturedAt: "2026-05-19T08:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
};

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
    supabaseMock.upsertAbortSignal.mockResolvedValue({ error: null });
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

  it("forwards an abort signal to an offline queue upsert", async () => {
    const { upsertPriwaKaeferbaum } = await import("./usePriwaKaeferbaeume");
    const signal = new AbortController().signal;

    await upsertPriwaKaeferbaum("project-1", basePoint, signal);

    expect(supabaseMock.upsertAbortSignal).toHaveBeenCalledWith(signal);
  });
});
