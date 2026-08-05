/* Pulse service worker — offline app shell.
   Your music itself lives in IndexedDB, not here, so the app works
   with zero network once installed. */
const VERSION = 'pulse-v7.2.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => {/* tolerate a missing optional file */}))
      /* deliberately NOT skipWaiting(): a new version waits until the user
         taps "Update now", so an update can never interrupt a workout. */
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

const SHARE_CACHE = 'pulse-shared';

/* Android share sheet → Pulse. Files are stashed in a cache and the app
   picks them up on the next load; nothing is sent anywhere. */
async function handleShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll('media').filter((f) => f && f.size);
    const meta = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      await cache.put(new Request(`./shared-file-${i}`), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      meta.push({ i, name: f.name || `shared-${i}`, type: f.type || '', size: f.size });
    }
    const link = (form.get('url') || form.get('text') || '').toString().trim();
    await cache.put(new Request('./shared-meta'), new Response(JSON.stringify({ files: meta, link, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('./index.html?shared=1', 303);
  } catch (e) {
    return Response.redirect('./index.html?shared=error', 303);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      // Cache-first with no background refetch: costs zero mobile data and
      // works identically in airplane mode. New versions arrive when the
      // browser (or the in-app "Check for an update" button) re-checks sw.js.
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
