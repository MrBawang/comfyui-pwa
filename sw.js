const CACHE = "comfyui-pwa-v3";
const ASSETS = ["/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e =>
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
);

self.addEventListener("fetch", e => {
  const url = e.request.url;
  // 永远不缓存：index.html、API、R2、Workers
  if (url.endsWith('/') || url.includes('index.html') ||
      url.includes('/api/') || url.includes('modal.run') ||
      url.includes('workers.dev') || url.includes('r2.dev') ||
      url.includes('r2.cloudflarestorage')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
