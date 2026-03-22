const CACHE = "comfyui-pwa-v2";
const ASSETS = ["/manifest.json"];  // 只缓存 manifest，不缓存 index.html

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting(); // 立即激活新 SW
});

self.addEventListener("activate", e =>
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim())) // 立即接管所有页面
);

self.addEventListener("fetch", e => {
  // index.html 永远走网络，不缓存
  if (e.request.url.endsWith('/') || e.request.url.endsWith('index.html')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // API 请求不缓存
  if (e.request.url.includes('/api/') || e.request.url.includes('modal.run') || e.request.url.includes('workers.dev') || e.request.url.includes('r2.dev')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // 其他资源（manifest 等）走缓存优先
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
