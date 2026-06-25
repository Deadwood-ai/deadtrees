import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const orderCreatedAt = vi.fn().mockResolvedValue({ data: [], error: null });
  const orderCaptureDate = vi.fn(() => ({ order: orderCreatedAt }));
  const orderSort = vi.fn(() => ({ order: orderCaptureDate }));
  const eqIsActive = vi.fn(() => ({ order: orderSort }));
  const eqProject = vi.fn(() => ({ eq: eqIsActive }));
  const select = vi.fn(() => ({ eq: eqProject }));
  const from = vi.fn(() => ({ select }));

  return {
    eqIsActive,
    eqProject,
    from,
    orderCaptureDate,
    orderCreatedAt,
    orderSort,
    select,
  };
});

vi.mock("../../hooks/useSupabase", () => ({
  supabase: {
    from: supabaseMock.from,
  },
}));

describe("fetchPriwaMosaics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.orderCreatedAt.mockResolvedValue({
      data: [
        {
          id: "mosaic-1",
          project_id: "project-1",
          label: "Flug 2026-06-24",
          cog_url: "priwa/project-1/flights/2026-06-24.tif",
          capture_date: "2026-06-24",
        },
      ],
      error: null,
    });
  });

  it("fetches active mosaics for one PRIWA project in display order", async () => {
    const { fetchPriwaMosaics } = await import("./usePriwaMosaics");

    await expect(fetchPriwaMosaics("project-1")).resolves.toEqual([
      {
        id: "mosaic-1",
        projectId: "project-1",
        label: "Flug 2026-06-24",
        cogUrl: "priwa/project-1/flights/2026-06-24.tif",
        captureDate: "2026-06-24",
      },
    ]);

    expect(supabaseMock.from).toHaveBeenCalledWith("priwa_project_mosaics");
    expect(supabaseMock.select).toHaveBeenCalledWith(
      "id, project_id, label, cog_url, capture_date",
    );
    expect(supabaseMock.eqProject).toHaveBeenCalledWith(
      "project_id",
      "project-1",
    );
    expect(supabaseMock.eqIsActive).toHaveBeenCalledWith("is_active", true);
    expect(supabaseMock.orderSort).toHaveBeenCalledWith("sort_order", {
      ascending: true,
    });
    expect(supabaseMock.orderCaptureDate).toHaveBeenCalledWith(
      "capture_date",
      { ascending: false, nullsFirst: false },
    );
    expect(supabaseMock.orderCreatedAt).toHaveBeenCalledWith("created_at", {
      ascending: false,
    });
  });
});
