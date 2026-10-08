/* Elvar service worker — offline shell for GitHub Pages.
   Bump CACHE_VERSION on every deploy so phones pick up the new files. */
const CACHE_VERSION = 'elvar-v25';
const AUDIO_CACHE = 'elvar-audio-v1';
const PUSHED_CACHE = 'elvar-pushed';        /* ids of reminders already shown by a push, so the app does not show them twice */   /* saved-for-offline sounds; survives app updates */
const SHELL = [
  './', 'index.html', 'manifest.json', 'version.json', 'firebase-sync.js', 'elvar-admin-link.js', 'elvar-push.js',
  'icon-192.png', 'icon-512.png', 'icon-light-192.png', 'icon-light-512.png',
  'icon-maskable-512.png', 'apple-touch-icon.png', 'audio/elvar-secret.mp3'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== AUDIO_CACHE && k !== PUSHED_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Hosts that must always go straight to the network (auth + database traffic). */
const LIVE = /(firestore|identitytoolkit|securetoken|firebaseinstallations)\.googleapis\.com|accounts\.google\.com|apis\.google\.com|firebaseapp\.com\/__\/auth/;
/* Static CDN files that never change for a given URL: fonts + pinned Firebase SDK modules. */
const STATIC_CDN = /fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs\//;

/* Big audio files: streamed from the network, or served from the offline copy the user saved.
   Audio elements ask for byte ranges, and a plain cache hit ignores that (Safari then refuses to
   play), so cached files are answered with a proper 206 partial response. */
const AUDIO_FILE = /\/audio\/[^?]+\.(mp3|m4a|aac|ogg|oga|opus|wav|webm|flac)$/i;
async function serveAudio(req) {
  const hit = await caches.match(req.url);
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return hit;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const blob = await hit.blob();
  const size = blob.size;
  let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0;
  let end = m && m[2] !== '' ? parseInt(m[2], 10) : size - 1;
  if (m && m[1] === '' && m[2] !== '') { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  end = Math.min(end, size - 1);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (LIVE.test(req.url)) return;

  if (url.origin === self.location.origin && /\/audio\/library\.json$/i.test(url.pathname)) {
    /* The sounds list: always try the network so new tracks appear, fall back to the last copy offline. */
    e.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }
  if (url.origin === self.location.origin && AUDIO_FILE.test(url.pathname)) {
    e.respondWith(serveAudio(req));
    return;
  }

  /* Page loads: network first (so a deploy shows up on next open), cache as fallback. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  /* App code and lists (.js .json .html): fresh copy first so an update never mixes old and new files,
     the saved copy is used only when offline. */
  if (url.origin === self.location.origin && /\.(js|json|html|webmanifest)$/i.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  /* Other same-origin files (icons): serve cache instantly, refresh in the background. */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE_VERSION).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req)
            .then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; })
            .catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  /* Fonts and pinned Firebase SDK files: cache first, fill cache on first use. */
  if (STATIC_CDN.test(req.url)) {
    e.respondWith(
      caches.open(CACHE_VERSION).then((c) =>
        c.match(req).then((hit) =>
          hit || fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; })
        )
      )
    );
  }
});

/* ---- Push reminders (sent by the free Cloudflare worker through Firebase Cloud Messaging) ----
   The message carries only data; the notification is built here so it looks like the app's own ones.
   The tag is the same one the app uses, so if the app also shows it, one replaces the other. */
function inQuietHours(info) {
  const p = String(info || '').split('|');
  if (p[0] !== '1') return false;
  const mins = (t) => { const a = String(t || '').split(':'); return (+a[0] || 0) * 60 + (+a[1] || 0); };
  const n = new Date(), m = n.getHours() * 60 + n.getMinutes(), f = mins(p[1]), t = mins(p[2]);
  if (f === t) return false;
  return f < t ? (m >= f && m < t) : (m >= f || m < t);
}
/* The words are written here, at the moment the notification is shown, from the phone's real clock.
   Exams: "starts in 1 hour" / "starts in 30 min" / "starts now" / "started at 10:00" (never says something untrue).
   Custom + note reminders that arrive late say when they were due. */
function pushWords(d) {
  const now = Date.now();
  if (d.exst) {
    const st = +d.exst, ms = st - now, w = d.exw || '';
    if (ms > 0) {
      const mins = Math.ceil(ms / 60000);
      return { title: d.exn + ' starts in ' + (mins >= 60 ? '1 hour' : mins + ' min'), body: (d.extm || '') + w };
    }
    const late = -ms;
    return late <= 90000
      ? { title: d.exn + ' starts now', body: "Good luck \u2014 you've prepared for this" + w }
      : { title: d.exn + ' started at ' + (d.extm || ''), body: 'Started ' + Math.max(1, Math.round(late / 60000)) + ' min ago' + w };
  }
  let body = d.body || '';
  if (d.late === '1' && d.at && d.hm && now - (+d.at) > 90000) body += (body ? ' \u00B7 ' : '') + 'was due ' + d.hm;
  return { title: d.title || 'Elvar', body };
}
self.addEventListener('push', (e) => {
  let j = {};
  try { j = e.data ? e.data.json() : {}; } catch (x) { try { j = { data: { body: e.data.text() } }; } catch (y) {} }
  const d = (j && j.data) || j || {};
  const id = d.id || '';
  const words = pushWords(d);
  e.waitUntil((async () => {
    if (id) {
      try {
        const c = await caches.open(PUSHED_CACHE);
        await c.put('/__pushed/' + encodeURIComponent(id), new Response('1'));
        const keys = await c.keys();
        if (keys.length > 150) await Promise.all(keys.slice(0, keys.length - 100).map((k) => c.delete(k)));
      } catch (x) {}
    }
    const tag = d.tag || ('edubba-' + (id || words.title));
    await self.registration.showNotification(words.title, {
      body: words.body,
      tag,
      renotify: d.renotify === '1',      /* the exam start alert replaces the heads-up and alerts again */
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { id: id, kind: d.kind || '', rawId: d.rawId || '' },
      silent: inQuietHours(d.quiet)
    });
  })());
});

/* Tapping a notification, or one of its buttons (the timer one has Pause / Save). The tap is passed to the
   open app as an "intent"; if the app is not running it is started with the intent in the address. */
async function handleNotificationClick(n, action) {
  const d = (n && n.data) || {};
  const intent = { timer: !!d.timer, id: d.id || '', kind: d.kind || '', rawId: d.rawId, action: action || '' };
  const silent = intent.timer && (intent.action === 'toggle' || intent.action === 'cancel');   /* controls work without opening the app */
  /* The live timer notification stays until the app itself confirms it paused / stopped. */
  if (!(intent.timer && silent)) { try { n.close(); } catch (e) {} }
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.length) {
    const c = wins.find((x) => x.visibilityState === 'visible') || wins[0];
    c.postMessage({ type: 'elvar-notif-intent', intent });
    if (!silent) { try { await c.focus(); } catch (e) {} }
    return;
  }
  const q = btoa(unescape(encodeURIComponent(JSON.stringify(intent))));
  return self.clients.openWindow('./?ni=' + encodeURIComponent(q));
}
self.addEventListener('notificationclick', (e) => {
  e.waitUntil(handleNotificationClick(e.notification, e.action));
});
