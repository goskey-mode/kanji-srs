// ホーム画面に追加（インストール）できるようにするためだけの Service Worker。
// キャッシュはしない（古い画面が残って、直した内容が届かなくなるのを避ける）。
// API・写真など別のサーバーへの通信と GET 以外には関わらず、ブラウザにそのまま任せる。
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request));
});
