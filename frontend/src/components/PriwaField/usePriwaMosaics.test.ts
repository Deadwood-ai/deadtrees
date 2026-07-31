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
    supabaseMock.datasetQuery.limit.mockResolvedValue({
      data: [],
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({
      data: [
        {
          id: "dataset-1",
          project_id: "project-1",
          label: "Flug 2026-06-24",
          cog_url: "uploads/project-1/flights/2026-06-24.tif",
          bbox: "BOX(8.1 48.4,8.2 48.5)",
          capture_date: "2026-06-24",
          created_at: "2026-06-25T08:30:00.000Z",
          authors: ["PRIWA Wald"],
          additional_information: "Sommerbefliegung",
          flight_type: null,
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
        bbox: "BOX(8.1 48.4,8.2 48.5)",
        captureDate: "2026-06-24",
        createdAt: "2026-06-25T08:30:00.000Z",
        authors: ["PRIWA Wald"],
        additionalInformation: "Sommerbefliegung",
        flightType: null,
      },
    ]);

    expect(supabaseMock.rpc).toHaveBeenCalledWith(
      "priwa_project_latest_flight_mosaics",
      {
        p_project_id: "project-1",
        p_limit: 100,
        p_offset: 0,
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
          bbox: "BOX(8.1 48.4,8.2 48.5)",
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
          bbox: "BOX(8.0 48.3,8.1 48.4)",
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
        bbox: "BOX(8.1 48.4,8.2 48.5)",
        captureDate: "2026-06-21",
        createdAt: "2026-06-22T12:12:44.567Z",
        authors: ["PRIMA-Wald"],
        additionalInformation: "Fallback mosaic",
        flightType: null,
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

  it("loads every page instead of silently truncating at 50 flights", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index + 1),
      project_id: "project-1",
      label: `Flug ${index + 1}`,
      cog_url: `flight-${index + 1}.tif`,
      bbox: "BOX(8.1 48.4,8.2 48.5)",
      capture_date: "2026-06-24",
      created_at: "2026-06-25T08:30:00.000Z",
      authors: ["PRIWA"],
      additional_information: null,
      flight_type: null,
    }));
    const finalPage = [
      {
        ...firstPage[0],
        id: "101",
        label: "Flug 101",
        cog_url: "flight-101.tif",
      },
    ];
    supabaseMock.rpc
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: finalPage, error: null });

    const { fetchPriwaMosaics } = await import("./usePriwaMosaics");
    const result = await fetchPriwaMosaics("project-1");

    expect(result).toHaveLength(101);
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(
      1,
      "priwa_project_latest_flight_mosaics",
      {
        p_project_id: "project-1",
        p_limit: 100,
        p_offset: 0,
      },
    );
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(
      2,
      "priwa_project_latest_flight_mosaics",
      {
        p_project_id: "project-1",
        p_limit: 100,
        p_offset: 100,
      },
    );
  });

  it("persists an explicit editable flight classification", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: "umfeldbefliegung",
      error: null,
    });
    const { setPriwaFlightType } = await import("./usePriwaMosaics");

    await expect(
      setPriwaFlightType("project-1", "10512", "umfeldbefliegung"),
    ).resolves.toBeUndefined();

    expect(supabaseMock.rpc).toHaveBeenCalledWith(
      "priwa_set_project_flight_type",
      {
        p_project_id: "project-1",
        p_dataset_id: 10512,
        p_flight_type: "umfeldbefliegung",
      },
    );
  });
});
