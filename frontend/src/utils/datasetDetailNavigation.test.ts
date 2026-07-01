import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  getPublicDatasetByIdQueryKey,
  openDatasetDetail,
} from "./datasetDetailNavigation";

describe("openDatasetDetail", () => {
  it("primes the dataset detail cache and navigates immediately", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    const dataset = {
      id: 10610,
      file_name: "LB-Hofberg-20260630",
      is_cog_done: true,
    };

    openDatasetDetail({
      queryClient,
      navigate,
      dataset,
      authStatus: "authenticated",
      userId: "user-123",
    });

    const queryKey = getPublicDatasetByIdQueryKey(10610, "authenticated", "user-123");
    expect(queryClient.getQueryData(queryKey)).toBe(dataset);
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/dataset/10610");
  });
});
