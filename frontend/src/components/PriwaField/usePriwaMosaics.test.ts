import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => {
  const rpc = vi.fn();
  const from = vi.fn();
  const datasetQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    not: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };

  return {
    datasetQuery,
    from,
    rpc,
  };
});

vi.mock("../../hooks/useSupabase", () => ({
  supabase: {
    from: supabaseMock.from,
    rpc: supabaseMock.rpc,
  },
}));

describe("fetchPriwaMosaics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.from.mockReturnValue(supabaseMock.datasetQuery);
    supabaseMock.datasetQuery.select.mockReturnValue(supabaseMock.datasetQuery);
    supabaseMock.datasetQuery.eq.mockReturnValue(supabaseMock.datasetQuery);
    supabaseMock.datasetQuery.not.mockReturnValue(supabaseMock.datasetQuery);
    supabaseMock.datasetQuery.order.mockReturnValue(supabaseMock.datasetQuery);
    supabaseMock.datasetQuery.limit.mockResolvedValue({ data: [], error: null });
    supabaseMock.rpc.mockResolvedValue({
      data: [
        {
          id: "dataset-1",
          project_id: "project-1",
          label: "Flug 2026-06-24",
          cog_url: "uploads/project-1/flights/2026-06-24.tif",
          capture_date: "2026-06-24",
          created_at: "2026-06-25T08:30:00.000Z",
          authors: ["PRIWA Wald"],
          additional_information: "Sommerbefliegung",
        },
      ],
      error: null,
    });
  });

  it("fetches latest public COG mosaics uploaded by PRIWA project members", async () => {
    const { fetchPriwaMosaics } = await import("./usePriwaMosaics");

    await expect(fetchPriwaMosaics("project-1")).resolves.toEqual([
      {
        id: "dataset-1",
        projectId: "project-1",
        label: "Flug 2026-06-24",
        cogUrl: "uploads/project-1/flights/2026-06-24.tif",
        captureDate: "2026-06-24",
        createdAt: "2026-06-25T08:30:00.000Z",
        authors: ["PRIWA Wald"],
        additionalInformation: "Sommerbefliegung",
      },
    ]);

    expect(supabaseMock.rpc).toHaveBeenCalledWith(
      "priwa_project_latest_flight_mosaics",
      {
        p_project_id: "project-1",
        p_limit: 50,
      },
    );
  });

  it("falls back to public PRIWA-like drone COG datasets while the RPC is not deployed", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.priwa_project_latest_flight_mosaics",
      },
    });
    supabaseMock.datasetQuery.limit.mockResolvedValueOnce({
      data: [
        {
          id: 41,
          file_name: "latest-priwa-flight.tif",
          cog_path: "uploads/latest-priwa-flight-cog.tif",
          aquisition_year: 2026,
          aquisition_month: 6,
          aquisition_day: 21,
          created_at: "2026-06-22T12:12:44.567Z",
          authors: ["PRIMA-Wald"],
          additional_information: "Fallback mosaic",
        },
        {
          id: 42,
          file_name: "other-flight.tif",
          cog_path: "uploads/other-flight-cog.tif",
          aquisition_year: 2026,
          aquisition_month: 6,
          aquisition_day: 20,
          created_at: "2026-06-22T11:00:00.000Z",
          authors: ["Different uploader"],
          additional_information: null,
        },
      ],
      error: null,
    });
    const { fetchPriwaMosaics } = await import("./usePriwaMosaics");

    await expect(fetchPriwaMosaics("project-1")).resolves.toEqual([
      {
        id: "41",
        projectId: "project-1",
        label: "latest-priwa-flight.tif",
        cogUrl: "uploads/latest-priwa-flight-cog.tif",
        captureDate: "2026-06-21",
        createdAt: "2026-06-22T12:12:44.567Z",
        authors: ["PRIMA-Wald"],
        additionalInformation: "Fallback mosaic",
      },
    ]);

    expect(supabaseMock.from).toHaveBeenCalledWith(
      "v2_full_dataset_view_public",
    );
    expect(supabaseMock.datasetQuery.eq).toHaveBeenCalledWith(
      "platform",
      "drone",
    );
    expect(supabaseMock.datasetQuery.eq).toHaveBeenCalledWith(
      "is_cog_done",
      true,
    );
    expect(supabaseMock.datasetQuery.not).toHaveBeenCalledWith(
      "cog_path",
      "is",
      null,
    );
  });
});
