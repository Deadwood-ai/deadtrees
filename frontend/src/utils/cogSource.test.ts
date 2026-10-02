import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCogRange, getCachedCoverCogSource } from "./cogSource";

const RANGE = { Range: "bytes=0-65535" };
const NO_DELAY = [0, 0, 0];

const respond = (status: number) => new Response(status === 206 ? "tile" : null, { status });

describe("fetchCogRange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the range outside the HTTP cache so ranges of one file load in parallel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(206));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchCogRange("https://example.org/a.tif", RANGE);

    expect(response.status).toBe(206);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.org/a.tif",
      expect.objectContaining({ headers: RANGE, cache: "no-store" }),
    );
  });

  it("retries a dropped connection and a server error, then returns the data", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(206));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchCogRange("https://example.org/a.tif", RANGE, undefined, NO_DELAY);

    expect(response.status).toBe(206);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refused or missing file", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(403));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchCogRange("https://example.org/a.tif", RANGE, undefined, NO_DELAY);

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last retry and reports the failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCogRange("https://example.org/a.tif", RANGE, undefined, NO_DELAY),
    ).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(NO_DELAY.length + 1);
  });

  it("stops retrying once the request is aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCogRange("https://example.org/a.tif", RANGE, controller.signal, NO_DELAY),
    ).rejects.toThrow("Aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCachedCoverCogSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses a source for the same file", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    const first = getCachedCoverCogSource("https://example.org/reused.tif");

    expect(getCachedCoverCogSource("https://example.org/reused.tif")).toBe(first);
  });

  it("starts over after a source failed to load, instead of keeping it blank", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(404)));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const failed = getCachedCoverCogSource("https://example.org/missing.tif");
    await vi.waitFor(() => expect(failed.getState()).toBe("error"));

    expect(getCachedCoverCogSource("https://example.org/missing.tif")).not.toBe(failed);
  });
});
