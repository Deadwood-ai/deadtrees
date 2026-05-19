const CACHE_VERSION = "priwa-app-shell-v1";
const APP_SHELL_CACHE = `deadtrees-${CACHE_VERSION}`;
const APP_SHELL_URLS = [
  "/",
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
          APP_SHELL_URLS.map(
            (url) => new Request(url, { cache: "reload" }),
          ),
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
            .filter((cacheName) => cacheName !== APP_SHELL_CACHE)
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
      (await caches.match("/"))
    );
  }
};

const handleSameOriginAsset = async (request) => {
  const cachedResponse = await caches.match(request);
  const networkResponsePromise = fetch(request)
    .then((response) => cacheSuccessfulResponse(request, response))
    .catch(() => cachedResponse);

  return cachedResponse || networkResponsePromise;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) {
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
