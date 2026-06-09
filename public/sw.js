// Castform service worker — offline support + installability (PWA).
//
// Strategy:
//   - App shell / same-origin static: cache-first, then network.
//   - API + cross-origin data (Open-Meteo, CDN tiles/libs): network-first,
//     falling back to cache — so an offline launch shows the last forecast.
//
// Bump VERSION to invalidate old caches on deploy.
const VERSION = "castform-v6";

// Files to pre-cache. Some only exist on the dev server (split CSS/JS), others
// only on the bundled GitHub Pages build — failures are ignored individually.
const SHELL = ["./", "./index.html", "./manifest.json", "./css/styles.css",
  "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cachePut(req, res) {
  const copy = res.clone();
  caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Data / cross-origin → network-first, cache fallback (offline = last data).
  if (url.pathname.includes("/api/") || url.origin !== location.origin) {
    e.respondWith(fetch(req).then((res) => cachePut(req, res)).catch(() => caches.match(req)));
    return;
  }

  // HTML navigations → network-first, so a new index.html (and the freshly
  // cache-busted CSS/JS it points to) lands as soon as the device is online.
  // Falls back to the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => cachePut(req, res))
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  // Other same-origin static (CSS/JS/icons, cache-busted by ?b=) → cache-first.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => cachePut(req, res)).catch(() => caches.match("./index.html")))
  );
});
