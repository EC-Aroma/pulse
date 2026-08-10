/* Pulse service worker — offline app shell.
   Your music itself lives in IndexedDB, not here, so the app works
   with zero network once installed. */
const VERSION = 'pulse-v10.11.0';
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

/* The page hands the worker its Drive token so audio can be streamed rather
   than downloaded. Kept in memory here, exactly as it is in the page — it is
   never written to a cache or IndexedDB, and it dies with the worker. */
let driveToken = null;
let driveTokenAt = 0;
let driveNote = 'nothing tried yet';        /* plain-English trace for the cloud check */
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') { self.skipWaiting(); return; }
  if (e.data && e.data.type === 'drive-token') {
    driveToken = e.data.token || null;
    driveTokenAt = driveToken ? Date.now() : 0;
    driveNote = driveToken ? 'the app handed me a key' : 'the app said it has no key';
  }
  /* the cloud check asking the worker to describe itself */
  if (e.data && e.data.type === 'ping' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({
      version: VERSION,
      hasToken: !!driveToken,
      tokenAgeSec: driveToken ? Math.round((Date.now() - driveTokenAt) / 1000) : null,
      note: driveNote
    });
  }
});

/* Play straight from Drive with no copy on the phone.
   The <audio> element cannot send an Authorization header, so it asks this
   worker for a local URL instead; the worker adds the header and forwards the
   request to Google, passing the Range through untouched. That is what makes
   seeking work: the browser asks for the byte range it wants and gets a 206
   back, the same as it would from any ordinary media server. */
/* A worker is stopped whenever the phone decides it is idle, and the token
   goes with it. Rather than fail, ask the app for a fresh one and wait a
   moment — the player only ever sees a slightly slower first byte. */
async function askClientsForToken() {
  try {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!all.length) return null;
    all.forEach((c) => c.postMessage({ type: 'need-drive-token' }));
    for (let i = 0; i < 30 && !driveToken; i++) await new Promise((r) => setTimeout(r, 100));
  } catch (e) {}
  return driveToken;
}

/* How big is the file? Needed to write a correct Content-Range (see below).
   The app puts it in the address for new tracks; older ones we ask Drive once
   and remember. */
const driveSizes = new Map();
async function driveSize(id) {
  if (driveSizes.has(id)) return driveSizes.get(id);
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=size',
      { headers: { Authorization: 'Bearer ' + driveToken }, cache: 'no-store' });
    const d = await r.json();
    const n = +d.size || 0;
    if (n) driveSizes.set(id, n);
    return n;
  } catch (e) { return 0; }
}

async function driveStream(req, url) {
  const id = decodeURIComponent((url.pathname.split('/drive-stream/')[1] || '').split('?')[0]);
  if (!id) return new Response('No file id in the address', { status: 400 });
  if (!driveToken) {
    driveNote = 'no key in memory — asked the app for one';
    await askClientsForToken();
  }
  if (!driveToken) {
    driveNote = 'the app never answered with a key (is it signed in to Drive?)';
    return new Response('Not connected to Drive: ' + driveNote, { status: 401 });
  }
  const range = req.headers.get('range');
  const call = () => {
    const headers = { Authorization: 'Bearer ' + driveToken };
    if (range) headers.Range = range;
    return fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media',
      { headers, cache: 'no-store' });
  };
  let r;
  try {
    r = await call();
    /* an hour-old token: bin it, ask for a new one, try once more */
    if (r.status === 401 || r.status === 403) {
      let body = '';
      try { body = (await r.clone().text()).slice(0, 300); } catch (e) {}
      driveNote = 'Google refused the key (' + r.status + ') ' + body;
      driveToken = null;
      await askClientsForToken();
      if (driveToken) r = await call();
    }
    if (!r.ok && r.status !== 206) {
      let body = '';
      try { body = (await r.clone().text()).slice(0, 400); } catch (e) {}
      driveNote = 'Google said ' + r.status + ' ' + body;
      return new Response(driveNote, { status: r.status });
    }
    driveNote = 'last request worked (' + r.status + ')';
  } catch (e) {
    driveNote = 'could not reach Google at all: ' + ((e && e.message) || e);
    return new Response(driveNote, { status: 504 });
  }
  /* Rebuild the headers rather than copy them.
     Google answers us across origins, and a cross-origin response only lets
     script read the handful of CORS-safelisted headers — Content-Type and
     Content-Length are on that list, Content-Range is not. So a 206 arrives
     here with its Content-Range invisible, and a 206 without one is invalid:
     Chrome's media stack rejects it outright, which is a track that fetches
     perfectly but refuses to play. We know the range we asked for and the
     size of the file, so we write the header ourselves. */
  const h = new Headers();
  const type = r.headers.get('content-type');
  h.set('content-type', (!type || /octet-stream/i.test(type))
    ? (url.searchParams.get('mime') || 'audio/mpeg') : type);
  const len = +r.headers.get('content-length') || 0;
  let total = +url.searchParams.get('size') || 0;
  if (!total) total = await driveSize(id);

  if (r.status === 206) {
    const passed = r.headers.get('content-range');       /* if it is visible, trust it */
    if (passed) h.set('content-range', passed);
    else {
      const m = /bytes=(\d*)-(\d*)/.exec(range || '');
      const start = m && m[1] !== '' ? +m[1] : 0;
      const end = len ? start + len - 1
        : (m && m[2] !== '' ? +m[2] : (total ? total - 1 : start));
      h.set('content-range', 'bytes ' + start + '-' + end + '/' + (total || (end + 1)));
    }
    if (len) h.set('content-length', String(len));
  } else if (len) h.set('content-length', String(len));
  else if (total) h.set('content-length', String(total));

  h.set('accept-ranges', 'bytes');           /* tell the player it may seek */
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

/* ---- background update check (Chrome wakes installed PWAs on a schedule) ---- */
const GH_API = 'https://api.github.com/repos/EC-Aroma/pulse/commits?per_page=1&sha=main';
async function checkForUpdate() {
  try {
    const res = await fetch(GH_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();
    const c = Array.isArray(d) ? d[0] : null;
    if (!c) return;
    const meta = await caches.open('pulse-meta');
    const prev = await meta.match('./applied-sha');
    const applied = prev ? await prev.text() : null;
    if (!applied) { await meta.put('./applied-sha', new Response(c.sha)); return; }
    if (applied === c.sha) return;
    const seen = await meta.match('./notified-sha');
    if (seen && (await seen.text()) === c.sha) return;      // do not nag twice
    await meta.put('./notified-sha', new Response(c.sha));
    await self.registration.showNotification('Pulse update available', {
      body: (c.commit && c.commit.message || '').split('\n')[0] || 'A newer build is on GitHub',
      icon: './icon-192.png', badge: './icon-192.png', tag: 'pulse-update'
    });
  } catch (e) {}
}
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'pulse-update-check') e.waitUntil(checkForUpdate());
});
self.addEventListener('sync', (e) => {
  if (e.tag === 'pulse-update-check') e.waitUntil(checkForUpdate());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.includes('/pulse')) { c.focus(); return; }
    await self.clients.openWindow('./index.html?update=1');
  })());
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
  {
    const u = new URL(req.url);
    if (u.origin === location.origin && u.pathname.includes('/drive-stream/')) {
      e.respondWith(driveStream(req, u));
      return;
    }
  }
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
