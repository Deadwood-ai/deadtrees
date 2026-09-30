import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("./useSupabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const request = {
  title: "Freiburg by Ada Lovelace - part of deadtrees.earth",
  authors: [{ first_name: "Ada", last_name: "Lovelace", organisation: "Uni Freiburg" }],
  datasetIds: [11, 12],
};

describe("data publication creation", () => {
  beforeEach(() => rpc.mockReset());

  it("creates the publication, authors and dataset links in one RPC", async () => {
    rpc.mockResolvedValue({ data: 42, error: null });
    const { createDataPublication } = await import("./useDataPublications");

    await expect(createDataPublication(request)).resolves.toBe(42);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_data_publication", {
      p_title: request.title,
      p_description: null,
      p_authors: request.authors,
      p_dataset_ids: [11, 12],
    });
  });

  it("surfaces a rejected request", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("Dataset 11 is already in a publication request") });
    const { createDataPublication } = await import("./useDataPublications");

    await expect(createDataPublication(request)).rejects.toThrow("already in a publication request");
  });
});
