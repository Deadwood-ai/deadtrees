const CACHE_VERSION = "deadtrees-app-shell-v2";
const APP_SHELL_CACHE = CACHE_VERSION;
const BASEMAP_CACHE_PREFIX = "deadtrees-priwa-basemap-v1";
const VIEWED_BASEMAP_CACHE = `${BASEMAP_CACHE_PREFIX}-viewed`;
const LGL_BASEMAP_URL_PREFIX =
  "https://owsproxy.lgl-bw.de/owsproxy/ows/WMTS_LGL-BW_ATKIS_DOP_20_C";
const TOPOGRAPHIC_TILE_URL_PREFIX =
  "https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR";
const APP_SHELL_URLS = [
  "/",
  "/deadtrees",
  "/priwa-field",
  "/manifest.webmanifest",
  "/assets/favicon.png",
  "/assets/tree-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) =>
        cache.addAll(
          APP_SHELL_URLS.map((url) => new Request(url, { cache: "reload" })),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith("deadtrees-priwa-"))
            .filter(
              (cacheName) =>
                cacheName !== APP_SHELL_CACHE &&
                !cacheName.startsWith(BASEMAP_CACHE_PREFIX),
            )
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const cacheSuccessfulResponse = async (request, response) => {
  if (!response || !response.ok) return response;

  const cache = await caches.open(APP_SHELL_CACHE);
  await cache.put(request, response.clone());
  return response;
};

const handleNavigation = async (request) => {
  try {
    const response = await fetch(request);
    return cacheSuccessfulResponse(request, response);
  } catch {
    return (
      (await caches.match(request)) ||
      (await caches.match("/priwa-field")) ||
      (await caches.match("/")) ||
      new Response("deadtrees.earth is offline and the app shell is unavailable.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        status: 503,
        statusText: "Offline",
      })
    );
  }
};

const handleSameOriginAsset = async (request) => {
  const cachedResponse = await caches.match(request);
  const networkResponsePromise = fetch(request)
    .then((response) => cacheSuccessfulResponse(request, response))
    .catch(
      () =>
        cachedResponse ||
        new Response("", {
          status: 503,
          statusText: "Offline",
        }),
    );

  return cachedResponse || networkResponsePromise;
};

const isLglBasemapTileRequest = (requestUrl) =>
  requestUrl.href.startsWith(LGL_BASEMAP_URL_PREFIX);

const isTopographicTileRequest = (requestUrl) =>
  requestUrl.href.startsWith(`${TOPOGRAPHIC_TILE_URL_PREFIX}/`);

const isBasemapTileRequest = (requestUrl) =>
  isLglBasemapTileRequest(requestUrl) || isTopographicTileRequest(requestUrl);

const getSearchParamCaseInsensitive = (searchParams, key) => {
  const targetKey = key.toLowerCase();
  for (const [candidateKey, value] of searchParams.entries()) {
    if (candidateKey.toLowerCase() === targetKey) {
      return value;
    }
  }

  return null;
};

const appendWmtsParams = (url, params) => {
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  return `${url.replace(/[?&]$/, "")}${url.includes("?") ? "&" : "?"}${queryString}`;
};

const canonicalizeLglBasemapRequest = (request) => {
  const url = new URL(request.url);
  const tileMatrix = getSearchParamCaseInsensitive(
    url.searchParams,
    "TileMatrix",
  );
  const tileCol = getSearchParamCaseInsensitive(url.searchParams, "TileCol");
  const tileRow = getSearchParamCaseInsensitive(url.searchParams, "TileRow");

  if (!tileMatrix || !tileCol || !tileRow) {
    return request;
  }

  const baseUrl = appendWmtsParams(LGL_BASEMAP_URL_PREFIX, {
    layer: "DOP_20_C",
    style: "default",
    tilematrixset: "GoogleMapsCompatible",
    Service: "WMTS",
    Request: "GetTile",
    Version: "1.0.0",
    Format: "image/jpeg",
  });

  return new Request(
    appendWmtsParams(baseUrl, {
      TileMatrix: tileMatrix,
      TileCol: tileCol,
      TileRow: tileRow,
    }),
    request,
  );
};

const canonicalizeTopographicTileRequest = (request) => {
  const url = new URL(request.url);
  if (!isTopographicTileRequest(url)) {
    return request;
  }

  return new Request(
    `${url.origin}${url.pathname.replace(/\/+/g, "/")}`,
    request,
  );
};

const canonicalizeBasemapRequest = (request) => {
  const url = new URL(request.url);

  if (isLglBasemapTileRequest(url)) {
    return canonicalizeLglBasemapRequest(request);
  }

  if (isTopographicTileRequest(url)) {
    return canonicalizeTopographicTileRequest(request);
  }

  return request;
};

const cacheViewedBasemapResponse = async (request, response) => {
  if (!response || (!response.ok && response.type !== "opaque")) {
    return response;
  }

  const cache = await caches.open(VIEWED_BASEMAP_CACHE);
  await cache.put(request, response.clone()).catch(() => undefined);
  return response;
};

const createOfflineTileResponse = () =>
  new Response("", {
    status: 503,
    statusText: "Offline",
  });

const isExplicitBasemapCacheName = (cacheName) =>
  cacheName.startsWith(BASEMAP_CACHE_PREFIX) &&
  cacheName !== VIEWED_BASEMAP_CACHE;

const matchExplicitBasemapPackage = async (requests) => {
  const cacheNames = await caches.keys();

  for (const cacheName of cacheNames) {
    if (!isExplicitBasemapCacheName(cacheName)) {
      continue;
    }

    const cache = await caches.open(cacheName);
    for (const request of requests) {
      const response = await cache.match(request, { ignoreVary: true });
      if (response) {
        return response;
      }
    }
  }

  return null;
};

const handleBasemapTile = async (event) => {
  const { request } = event;
  const canonicalRequest = canonicalizeBasemapRequest(request);

  if (self.navigator && self.navigator.onLine === false) {
    return (
      (await matchExplicitBasemapPackage([canonicalRequest, request])) ||
      createOfflineTileResponse()
    );
  }

  const cachedResponse =
    (await caches.match(canonicalRequest, { ignoreVary: true })) ||
    (await caches.match(request, { ignoreVary: true }));

  const networkResponsePromise = fetch(request)
    .then((response) => cacheViewedBasemapResponse(canonicalRequest, response))
    .catch(
      async () =>
        (await matchExplicitBasemapPackage([canonicalRequest, request])) ||
        createOfflineTileResponse(),
    );

  if (cachedResponse) {
    event.waitUntil(networkResponsePromise);
    return cachedResponse;
  }

  return networkResponsePromise;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  if (isBasemapTileRequest(requestUrl)) {
    event.respondWith(handleBasemapTile(event));
    return;
  }

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (
    ["font", "image", "manifest", "script", "style", "worker"].includes(
      request.destination,
    )
  ) {
    event.respondWith(handleSameOriginAsset(request));
  }
});
