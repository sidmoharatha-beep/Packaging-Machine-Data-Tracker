// Caches the app shell (so the page itself loads with zero signal) and the Tesseract.js OCR
// engine files (so local text recognition works offline after the first successful online use).
const SHELL_CACHE = "mdt-shell-v1";
const ASSET_CACHE = "mdt-ocr-assets-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(["/", "/index.html"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Tesseract.js core/worker/language files come from a CDN - cache-first once fetched,
  // so the second (and every later) OCR run needs zero connectivity.
  const isOcrAsset =
    url.origin.includes("jsdelivr.net") ||
    url.origin.includes("unpkg.com") ||
    url.pathname.endsWith(".wasm") ||
    url.pathname.includes("traineddata");

  if (isOcrAsset) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const resp = await fetch(event.request);
          if (resp.ok) cache.put(event.request, resp.clone());
          return resp;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell: try network first (to stay fresh), fall back to cache when offline
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp.ok) caches.open(SHELL_CACHE).then((c) => c.put(event.request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match("/index.html")))
    );
  }
});
