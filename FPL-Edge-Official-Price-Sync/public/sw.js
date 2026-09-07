const CACHE='fpl-edge-shell-v1';
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/manifest.webmanifest','/icon.svg']))));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{ if(new URL(e.request.url).pathname.startsWith('/api/')) return; e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))); });
