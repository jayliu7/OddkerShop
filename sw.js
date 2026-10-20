/**
 * 歐客衛浴 PWA Service Worker (sw.js)
 * 策略：
 * 1. /api/sync-cart, /api/proxy, /checkout-proxy：永遠直連伺服器 (Bypass Cache)，確保購物車與結帳 Session 即時同步
 * 2. App Shell 靜態資源 (HTML/CSS/JS/Manifest/Icon)：Network-First + 離線快取備援，相容本機與 GitHub Pages 子路徑
 */

const CACHE_NAME = 'oddker-pwa-v4';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldKeys = keys.filter(k => k !== CACHE_NAME);
      await Promise.all(oldKeys.map(k => caches.delete(k)));
      await self.clients.claim();
      if (oldKeys.length > 0) {
        const clientList = await self.clients.matchAll({ type: 'window' });
        for (const client of clientList) {
          client.postMessage({ type: 'SW_CACHE_UPGRADED', version: CACHE_NAME });
        }
      }
    })()
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 所有 API 與結帳代理端點皆不進快取
  if (url.pathname.includes('/api/') || url.pathname.includes('/checkout-proxy')) {
    return;
  }

  // 同源靜態檔案採 Network-First，僅於離線時回退快取
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => {
          if (res && res.status === 200) {
            const cloned = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, cloned));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
