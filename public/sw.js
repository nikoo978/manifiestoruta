const VERSION = "v19";
const SHELL_CACHE = `ruta-envios-shell-${VERSION}`;
const RUNTIME_CACHE = `ruta-envios-runtime-${VERSION}`;
const APP_CACHES = [SHELL_CACHE, RUNTIME_CACHE];
const OFFLINE_SHELL = [
  "/",
  "/ocr",
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.allSettled(OFFLINE_SHELL.map(async (url) => {
    const response = await fetch(url, { cache: "reload" });
    if (response.ok) await cache.put(url, response);
  }));
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function putRuntime(request, response) {
  if (!response || !response.ok || response.type === "opaque") return response;
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response.clone());
  void trimCache(RUNTIME_CACHE, 100);
  return response;
}

async function networkFirst(request, fallbackPath) {
  try {
    const response = await fetch(request);
    return await putRuntime(request, response);
  } catch {
    return (await caches.match(request))
      || (fallbackPath ? await caches.match(fallbackPath) : undefined)
      || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => putRuntime(request, response))
    .catch(() => undefined);
  return cached || await network || Response.error();
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("ruta-envios-") && !APP_CACHES.includes(key))
      .map((key) => caches.delete(key)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/version.json") return;
  // No guardar respuestas RSC: pueden quedar desincronizadas con el HTML tras un deploy.
  if (url.searchParams.has("_rsc")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return await putRuntime(request, preload);
      } catch { /* continuar con network-first */ }
      return networkFirst(request, "/offline");
    })());
    return;
  }

  if (["script", "style", "worker"].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (["image", "font"].includes(request.destination) || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(request));
  }
});
