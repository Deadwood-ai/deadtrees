import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  getPublicDatasetByIdQueryKey,
  openDatasetDetail,
} from "./datasetDetailNavigation";

describe("openDatasetDetail", () => {
  it("marks existing detail data stale without caching a partial row and navigates immediately", () => {
    const invalidateQueries = vi.fn(() => new Promise(() => {}));
    const setQueryData = vi.fn();
    const queryClient = {
      invalidateQueries,
      setQueryData,
    } as unknown as QueryClient;
    const navigate = vi.fn();

    openDatasetDetail({
      queryClient,
      navigate,
      datasetId: 10610,
      authStatus: "authenticated",
      userId: "user-123",
    });

    const queryKey = getPublicDatasetByIdQueryKey(10610, "authenticated", "user-123");
    expect(setQueryData).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey,
      exact: true,
      refetchType: "none",
    });
    expect(navigate).toHaveBeenCalledWith("/dataset/10610");
  });
});
