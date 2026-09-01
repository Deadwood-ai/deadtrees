import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const serviceWorkerSource = readFileSync(
  new URL("../../public/sw.js", import.meta.url),
  "utf8",
);

const BASEMAP_TILE_URL =
  "https://owsproxy.lgl-bw.de/owsproxy/ows/WMTS_LGL-BW_ATKIS_DOP_20_C?" +
  new URLSearchParams({
    layer: "DOP_20_C",
    style: "default",
    tilematrixset: "GoogleMapsCompatible",
    Service: "WMTS",
    Request: "GetTile",
    Version: "1.0.0",
    Format: "image/jpeg",
    TileMatrix: "GoogleMapsCompatible:18",
    TileCol: "137001",
    TileRow: "90213",
  });
const VIEWED_BASEMAP_CACHE = "deadtrees-priwa-basemap-v1-viewed";
const EXPLICIT_BASEMAP_CACHE = "deadtrees-priwa-basemap-v1-project-id";
const BASEMAP_NETWORK_TIMEOUT_MS = 4_000;

type WorkerListener = (event: {
  request?: Request;
  respondWith?: (response: Response | Promise<Response>) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}) => void;

const createServiceWorkerHarness = ({
  isOnline = true,
  networkResponse = new Response("network tile", { status: 200 }),
}: {
  isOnline?: boolean;
  networkResponse?: Response;
} = {}) => {
  const listeners = new Map<string, WorkerListener>();
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(false),
    match: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  };
  const cacheStorage = {
    delete: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    match: vi.fn().mockResolvedValue(null),
    open: vi.fn().mockResolvedValue(cache),
  };
  const fetchMock = vi.fn().mockResolvedValue(networkResponse);
  const workerScope = {
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    navigator: { onLine: isOnline },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    addEventListener: (type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    },
  };

  runInNewContext(serviceWorkerSource, {
    AbortController,
    Promise,
    Request,
    Response,
    URL,
    URLSearchParams,
    caches: cacheStorage,
    clearTimeout,
    fetch: fetchMock,
    self: workerScope,
    setTimeout,
  });

  const dispatchBasemapRequest = async () => {
    const fetchListener = listeners.get("fetch");
    if (!fetchListener) throw new Error("Service worker fetch listener missing");

    let responsePromise: Promise<Response> | undefined;
    fetchListener({
      request: new Request(BASEMAP_TILE_URL),
      respondWith: (response) => {
        responsePromise = Promise.resolve(response);
      },
      waitUntil: vi.fn(),
    });

    if (!responsePromise) {
      throw new Error("Basemap request was not handled");
    }
    return responsePromise;
  };

  const dispatchActivate = async () => {
    const activateListener = listeners.get("activate");
    if (!activateListener) {
      throw new Error("Service worker activate listener missing");
    }

    let activationPromise: Promise<unknown> | undefined;
    activateListener({
      waitUntil: (promise) => {
        activationPromise = promise;
      },
    });

    if (!activationPromise) {
      throw new Error("Service worker activation was not handled");
    }
    await activationPromise;
  };

  return {
    cache,
    cacheStorage,
    dispatchActivate,
    dispatchBasemapRequest,
    fetchMock,
  };
};

describe("PRIWA basemap service worker", () => {
  it("keeps online tile requests out of Cache Storage", async () => {
    const harness = createServiceWorkerHarness();

    const response = await harness.dispatchBasemapRequest();

    expect(await response.text()).toBe("network tile");
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.cacheStorage.keys).not.toHaveBeenCalled();
    expect(harness.cacheStorage.match).not.toHaveBeenCalled();
    expect(harness.cacheStorage.open).not.toHaveBeenCalled();
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it("uses an explicit offline package after a network failure", async () => {
    const harness = createServiceWorkerHarness();
    harness.fetchMock.mockRejectedValueOnce(new Error("offline"));
    harness.cacheStorage.keys.mockResolvedValueOnce([EXPLICIT_BASEMAP_CACHE]);
    harness.cache.match.mockResolvedValueOnce(
      new Response("offline tile", { status: 200 }),
    );

    const response = await harness.dispatchBasemapRequest();

    expect(await response.text()).toBe("offline tile");
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.cacheStorage.open).toHaveBeenCalledWith(
      EXPLICIT_BASEMAP_CACHE,
    );
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it("uses an explicit offline package when the network request stalls", async () => {
    vi.useFakeTimers();
    try {
      const harness = createServiceWorkerHarness();
      harness.fetchMock.mockImplementationOnce(
        () => new Promise<Response>(() => undefined),
      );
      harness.cacheStorage.keys.mockResolvedValueOnce([EXPLICIT_BASEMAP_CACHE]);
      harness.cache.match.mockResolvedValueOnce(
        new Response("offline tile", { status: 200 }),
      );
      const responseResolved = vi.fn();

      void harness.dispatchBasemapRequest().then(responseResolved);
      await vi.advanceTimersByTimeAsync(BASEMAP_NETWORK_TIMEOUT_MS);

      expect(responseResolved).toHaveBeenCalledTimes(1);
      expect(await responseResolved.mock.calls[0][0].text()).toBe(
        "offline tile",
      );
      expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an explicit package without a network request when offline", async () => {
    const harness = createServiceWorkerHarness({ isOnline: false });
    harness.cacheStorage.keys.mockResolvedValueOnce([EXPLICIT_BASEMAP_CACHE]);
    harness.cache.match.mockResolvedValueOnce(
      new Response("offline tile", { status: 200 }),
    );

    const response = await harness.dispatchBasemapRequest();

    expect(await response.text()).toBe("offline tile");
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("removes the obsolete viewed cache without deleting offline packages", async () => {
    const harness = createServiceWorkerHarness();
    harness.cacheStorage.keys.mockResolvedValueOnce([
      VIEWED_BASEMAP_CACHE,
      EXPLICIT_BASEMAP_CACHE,
    ]);

    await harness.dispatchActivate();

    expect(harness.cacheStorage.delete).toHaveBeenCalledWith(
      VIEWED_BASEMAP_CACHE,
    );
    expect(harness.cacheStorage.delete).not.toHaveBeenCalledWith(
      EXPLICIT_BASEMAP_CACHE,
    );
  });
});
