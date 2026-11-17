import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../hooks/useSupabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
vi.mock("../config", () => ({ Settings: { API_URL: "http://api.test" } }));

import { searchDatasets } from "./searchEmbeddings";

const timeout = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
const ranked = { data: [{ dataset_id: 3, similarity: 0.8, tile_count: 2 }], error: null };

describe("AI dataset search", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: "[0.1]" }), { status: 200 })),
    );
  });
  afterEach(() => {
    rpc.mockReset();
    vi.unstubAllGlobals();
  });

  it("retries the ranking once after a cold-cache timeout, reusing the embedding", async () => {
    rpc.mockResolvedValueOnce(timeout).mockResolvedValueOnce(ranked);
    await expect(searchDatasets("dead trees")).resolves.toEqual(ranked.data);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains a second timeout instead of showing the database message", async () => {
    rpc.mockResolvedValue(timeout);
    await expect(searchDatasets("dead trees")).rejects.toThrow("The search took too long. Please try again.");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(searchDatasets("dead trees")).rejects.toThrow("permission denied");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
