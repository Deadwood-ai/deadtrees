import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestSegmentation,
  resetSamWarmUpForTests,
  SAM_STARTING_MESSAGE,
  SAM_UNREACHABLE_MESSAGE,
  SAM_WARMUP_INTERVAL_MS,
  warmUpSegmentation,
} from "./samRequest";

const fetchMock = vi.fn();

beforeEach(() => {
  resetSamWarmUpForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestSegmentation", () => {
  it("returns the parsed response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ type: "FeatureCollection", features: [] })));
    await expect(requestSegmentation(new FormData())).resolves.toEqual({ type: "FeatureCollection", features: [] });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("explains a timeout as a model that is still starting", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(requestSegmentation(new FormData())).rejects.toThrow(SAM_STARTING_MESSAGE);
  });

  it("explains a network failure as an unreachable service", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestSegmentation(new FormData())).rejects.toThrow(SAM_UNREACHABLE_MESSAGE);
  });

  it("reports an HTTP error status", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(requestSegmentation(new FormData())).rejects.toThrow("AI segmentation failed (500)");
  });
});

describe("warmUpSegmentation", () => {
  it("sends one warm-up per interval", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    expect(warmUpSegmentation(1_000_000)).toBe(true);
    expect(warmUpSegmentation(1_000_000 + SAM_WARMUP_INTERVAL_MS - 1)).toBe(false);
    expect(warmUpSegmentation(1_000_000 + SAM_WARMUP_INTERVAL_MS)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
