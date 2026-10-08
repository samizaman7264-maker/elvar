/* ============================================================
   Elvar — Firebase sync v2 (Auth + Firestore)
   Implements window.EdubbaSync, the API index.html calls.

   1. Paste your Firebase web config below (Console → Project settings → Your apps).
      This config is public by design; your data is protected by firestore.rules.
   2. Deploy next to index.html on GitHub Pages.

   What syncs: EVERY key the app stores (sessions, notes, wallet, profile + photos,
   settings…). Only a few device-local items are skipped (running timer, fired-notification
   log, sync bookkeeping). Users can switch whole categories on/off in Sync & Backup.

   Data model:  users/{uid}/kv/{storageKey}          → { v, t, d, tomb, n }
                users/{uid}/kv/{storageKey}~{1..n}   → extra chunks for values > 250k chars
   ============================================================ */

const firebaseConfig = {
  apiKey: 'AIzaSyA4NexRkgcSEesEataFwhH7ugM4Dwxds8I',
  authDomain: 'elvar-575.firebaseapp.com',
  projectId: 'elvar-575',
  storageBucket: 'elvar-575.firebasestorage.app',
  messagingSenderId: '46844657173',
  appId: '1:46844657173:web:0115b49011dfe1de7b181c'
};

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const configured = !/^YOUR_/.test(firebaseConfig.apiKey) && !/^YOUR_/.test(firebaseConfig.projectId);

/* ---------- what is / isn't synced ---------- */
const DEVICE_ONLY = new Set([
  'sv_timer', 'sv_notif_fired', 'sv_notif_gen_seeded', 'sv_splash_day',
  'sv_last_backup_count', 'sv_key_migr_bn', 'sv_conflict_mode', 'sv_exam_tomb'
]);
function isSyncKey(k) {
  if (typeof k !== 'string') return false;
  if (!(k.indexOf('sv_') === 0 || k.indexOf('mcq_') === 0 || k === 'naChips')) return false;
  if (k.indexOf('sv_sync_') === 0) return false;
  return !DEVICE_ONLY.has(k);
}
const CATS = [
  { id: 'study',    label: 'Study data',            desc: 'Sessions, subjects, terms, exams, schedule, routines, syllabus' },
  { id: 'mcq',      label: 'MCQ practice',          desc: 'Answer sheets, results and MCQ history' },
  { id: 'notes',    label: 'Notes & to-dos',        desc: 'Every note, checklist and label' },
  { id: 'wallet',   label: 'Wallet',                desc: 'Income, expenses, budgets and categories' },
  { id: 'profile',  label: 'Profile & photos',      desc: 'Your name, institute, photos and details' },
  { id: 'settings', label: 'Settings & appearance', desc: 'Theme, layout, shortcuts, notification preferences' }
];
const STUDY_KEYS = new Set(['sv_sess', 'sv_subj', 'sv_terms', 'sv_cur_term', 'sv_exams', 'sv_sched', 'sv_daylog',
  'sv_target', 'sv_th', 'sv_custom_type', 'sv_lastExamTime', 'sv_quickadd_log', 'sv_cur_routine_group', 'sv_pinned_routine_group']);
function catOf(k) {
  if (k === 'mcq_hist' || k.indexOf('sv_mcq_') === 0) return 'mcq';
  if (k.indexOf('sv_todo') === 0) return 'notes';
  if (k === 'sv_expenses' || k.indexOf('sv_wal') === 0) return 'wallet';
  if (k.indexOf('sv_profile_') === 0 || k === 'sv_onboarded') return 'profile';
  if (STUDY_KEYS.has(k) || k.indexOf('sv_routine_') === 0 || k.indexOf('sv_syl_') === 0) return 'study';
  return 'settings';
}

/* ---------- local storage helpers ---------- */
const META_KEY = 'sv_sync_meta';   /* { key: lastKnownUpdateMs } */
const TOMB_KEY = 'sv_sync_tomb';   /* { key: { id: deletedAtMs } } */
const UID_KEY = 'sv_sync_uid';
const DEV_KEY = 'sv_sync_device';
const CATS_KEY = 'sv_sync_cats';   /* { catId: false } when switched off */
const PAUSE_KEY = 'sv_sync_paused';
const LAST_KEY = 'sv_sync_last';
const TOMB_TTL = 90 * 24 * 3600 * 1000;
const CHUNK = 250000;              /* chars; ≤ 750 KB even if every char is 3 bytes (Bengali) */

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { console.error('sync: storage write failed', k, e); } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
const readJSON = (k, fb) => { try { const r = lsGet(k); return r == null ? fb : JSON.parse(r); } catch (e) { return fb; } };
const writeJSON = (k, v) => lsSet(k, JSON.stringify(v));

function allSyncKeys() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (isSyncKey(k)) out.push(k); } } catch (e) {}
  return out;
}
function catEnabled(cat) { return readJSON(CATS_KEY, {})[cat] !== false; }
function keyEnabled(k) { return isSyncKey(k) && catEnabled(catOf(k)); }
function isPaused() { return lsGet(PAUSE_KEY) === '1'; }

let deviceId = lsGet(DEV_KEY);
if (!deviceId) { deviceId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); lsSet(DEV_KEY, deviceId); }

/* ---------- state ---------- */
let conflictMode = 'merge';
let status = 'signed-out';
const statusListeners = [];
let pending = 0;
let initialSnapshotDone = false;
let lastError = '';
let lastSync = Number(lsGet(LAST_KEY)) || 0;
let A = null, F = null, auth = null, db = null, unsubSnap = null, currentUser = null;
const flushTimers = {};
const knownIds = {};
const cloud = new Map();           /* docId -> data, mirror of the user's kv collection */
const pendingDocs = new Set();     /* docIds with local, not-yet-confirmed writes */
let reloadTimer = null;
const appliedBeforeReady = new Set();   /* keys changed by the very first pull on this session */
const CORE_LIVE = new Set(['sv_subj','sv_sess','sv_terms','sv_daylog','sv_exams','sv_todos','sv_sched','mcq_hist','sv_cur_term']);

function computeStatus() {
  if (!currentUser) return 'signed-out';
  if (isPaused()) return 'paused';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (pending > 0 || !initialSnapshotDone) return 'syncing';
  return 'synced';
}
function emitStatus() {
  status = computeStatus();
  statusListeners.forEach((cb) => { try { cb(status); } catch (e) { console.error(e); } });
}
function markSynced() { lastSync = Date.now(); lsSet(LAST_KEY, String(lastSync)); }
window.addEventListener('online', emitStatus);
window.addEventListener('offline', emitStatus);

/* ---------- id-array helpers ---------- */
const idOf = (x) => (x && typeof x === 'object' && x.id !== undefined && x.id !== null) ? String(x.id) : null;
function isIdArray(a) { return Array.isArray(a) && a.every((x) => idOf(x) !== null); }
function trackIds(key, val) {
  if (Array.isArray(val) && (val.length === 0 || isIdArray(val))) knownIds[key] = new Set(val.map(idOf));
  else delete knownIds[key];
}
allSyncKeys().forEach((k) => trackIds(k, readJSON(k, null)));

function getTombs() { return readJSON(TOMB_KEY, {}); }
function saveTombs(t) { writeJSON(TOMB_KEY, t); }
function pruneTombs(map) {
  const now = Date.now(); const out = {};
  Object.keys(map || {}).forEach((id) => { if (now - map[id] < TOMB_TTL) out[id] = map[id]; });
  return out;
}
/* Runs on every app write, even signed-out/paused, so deletions are never forgotten. */
function noteLocalWrite(key, val) {
  if (!isSyncKey(key)) return;
  const tombs = getTombs();
  const kt = tombs[key] || (tombs[key] = {});
  if (Array.isArray(val) && (val.length === 0 || isIdArray(val))) {
    const now = new Set(val.map(idOf));
    const before = knownIds[key];
    if (before) before.forEach((id) => { if (!now.has(id)) kt[id] = Date.now(); });
    now.forEach((id) => { if (kt[id]) delete kt[id]; });
    knownIds[key] = now;
  } else { delete knownIds[key]; }
  tombs[key] = pruneTombs(kt);
  saveTombs(tombs);
}

/* ---------- push (chunked, atomic) ---------- */
function splitChunks(raw) {
  const parts = []; let i = 0;
  while (i < raw.length) {
    let end = Math.min(i + CHUNK, raw.length);
    if (end < raw.length) {   /* never cut a surrogate pair in half */
      const c = raw.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end--;
    }
    parts.push(raw.slice(i, end)); i = end;
  }
  return parts.length ? parts : [''];
}

function schedulePush(key, delay) {
  if (!currentUser || !db || isPaused() || !keyEnabled(key)) return;
  clearTimeout(flushTimers[key]);
  flushTimers[key] = setTimeout(() => flushKey(key), delay == null ? 1200 : delay);
}

async function flushKey(key) {
  if (!currentUser || !db || isPaused() || !keyEnabled(key)) return;
  const raw = lsGet(key);
  if (raw == null) return;
  const t = Date.now();
  const meta = readJSON(META_KEY, {}); meta[key] = t; writeJSON(META_KEY, meta);
  const tomb = pruneTombs(getTombs()[key] || {});
  const parts = splitChunks(raw);
  const uid = currentUser.uid;
  const ref = (id) => F.doc(db, 'users', uid, 'kv', id);
  const prev = cloud.get(key);
  const prevN = (prev && prev.n) || 0;
  const batch = F.writeBatch(db);
  if (parts.length <= 1) {
    batch.set(ref(key), { v: raw, t: t, d: deviceId, tomb: tomb, n: 0 });
  } else {
    parts.forEach((p, i) => batch.set(ref(key + '~' + (i + 1)), { v: p, t: t, d: deviceId, tomb: {}, n: 0 }));
    batch.set(ref(key), { v: '', t: t, d: deviceId, tomb: tomb, n: parts.length });
  }
  for (let i = (parts.length <= 1 ? 1 : parts.length + 1); i <= prevN; i++) batch.delete(ref(key + '~' + i));
  pending++; emitStatus();
  try {
    await batch.commit();
    lastError = ''; markSynced();
  } catch (e) {
    console.error('sync: push failed for', key, e);
    lastError = (e && e.code) ? String(e.code) : 'Upload failed';
  } finally {
    pending = Math.max(0, pending - 1); emitStatus();
  }
}

/* ---------- pull / merge ---------- */
function resolveKey(key) {
  const head = cloud.get(key);
  if (!head || typeof head.v !== 'string') return null;
  const n = head.n || 0;
  if (n <= 0) return head;
  let s = '';
  for (let i = 1; i <= n; i++) {
    const c = cloud.get(key + '~' + i);
    if (!c || c.t !== head.t || typeof c.v !== 'string') return null;   /* chunks still arriving */
    s += c.v;
  }
  return { v: s, t: head.t, d: head.d, tomb: head.tomb };
}
function applyLocal(key, valueJSON, t) {
  if (!initialSnapshotDone) appliedBeforeReady.add(key);
  lsSet(key, valueJSON);
  const meta = readJSON(META_KEY, {}); meta[key] = t; writeJSON(META_KEY, meta);
  try { trackIds(key, JSON.parse(valueJSON)); } catch (e) {}
}
function scheduleUIReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (typeof window.reloadAllStateFromStorage === 'function') {
      try { window.reloadAllStateFromStorage(); } catch (e) { console.error('sync: UI reload failed', e); }
    }
  }, 250);
}

function handleRemote(key, data) {
  if (!keyEnabled(key) || !data || typeof data.v !== 'string') return;
  const remoteT = Number(data.t) || 0;
  const meta = readJSON(META_KEY, {});
  const localT = Number(meta[key]) || 0;
  const localRaw = lsGet(key);
  let remoteVal; try { remoteVal = JSON.parse(data.v); } catch (e) { return; }
  let localVal = null; try { localVal = localRaw == null ? null : JSON.parse(localRaw); } catch (e) {}

  if (conflictMode === 'merge' && Array.isArray(remoteVal) && isIdArray(remoteVal) &&
      (localVal === null || (Array.isArray(localVal) && isIdArray(localVal)))) {
    const tombs = getTombs();
    const mine = pruneTombs(tombs[key] || {});
    const dead = Object.assign({}, pruneTombs(data.tomb || {}), mine);
    const remoteWins = remoteT > localT;
    const byId = new Map();
    (localVal || []).forEach((x) => byId.set(idOf(x), x));
    remoteVal.forEach((x) => { const id = idOf(x); if (!byId.has(id) || remoteWins) byId.set(id, x); });
    const merged = [];
    byId.forEach((x, id) => { if (!dead[id]) merged.push(x); });
    const mergedJSON = JSON.stringify(merged);
    tombs[key] = dead; saveTombs(tombs);
    if (mergedJSON !== localRaw) { applyLocal(key, mergedJSON, Math.max(localT, remoteT)); scheduleUIReload(); }
    else { meta[key] = Math.max(localT, remoteT); writeJSON(META_KEY, meta); }
    if (mergedJSON !== data.v) schedulePush(key, 400);
    return;
  }
  if (remoteT > localT) {
    if (data.v !== localRaw) { applyLocal(key, data.v, remoteT); scheduleUIReload(); }
    else { meta[key] = remoteT; writeJSON(META_KEY, meta); }
    if (data.tomb) {
      const tombs = getTombs();
      tombs[key] = Object.assign({}, pruneTombs(data.tomb), tombs[key] || {});
      saveTombs(tombs);
    }
  } else if (localT > remoteT && localRaw !== data.v) {
    schedulePush(key, 400);
  }
}

function evaluateKey(key) {
  if (isPaused() || !keyEnabled(key)) return;
  if (pendingDocs.has(key)) return;
  const data = resolveKey(key);
  if (!data) return;
  if (data.d === deviceId && (Number(data.t) || 0) <= (Number(readJSON(META_KEY, {})[key]) || 0)) return;
  handleRemote(key, data);
}
function evaluateAll() { const keys = new Set(); cloud.forEach((_, id) => keys.add(id.split('~')[0])); keys.forEach(evaluateKey); }

function startListening(user) {
  stopListening();
  initialSnapshotDone = false; cloud.clear(); pendingDocs.clear();
  const col = F.collection(db, 'users', user.uid, 'kv');
  unsubSnap = F.onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
    const touched = new Set();
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      if (ch.type === 'removed') { cloud.delete(id); pendingDocs.delete(id); }
      else {
        cloud.set(id, ch.doc.data());
        if (ch.doc.metadata.hasPendingWrites) pendingDocs.add(id); else pendingDocs.delete(id);
      }
      touched.add(id.split('~')[0]);
    });
    touched.forEach(evaluateKey);
    if (!initialSnapshotDone && !snap.metadata.fromCache) {
      initialSnapshotDone = true;
      const needsRefresh = Array.from(appliedBeforeReady).filter((k) => !CORE_LIVE.has(k));
      appliedBeforeReady.clear();
      if (needsRefresh.length) {       /* settings / wallet / profile arrived — the page must reload once to show them */
        try { window.dispatchEvent(new CustomEvent('elvar-sync-initial', { detail: { keys: needsRefresh } })); } catch (e) {}
      }
      if (!isPaused()) allSyncKeys().forEach((k) => {      /* first upload: local keys the cloud has never seen */
        if (!keyEnabled(k) || cloud.has(k)) return;
        const raw = lsGet(k);
        if (raw != null && raw !== '[]' && raw !== 'null' && raw !== '{}' && raw !== '""') schedulePush(k, 200);
      });
    }
    if (!snap.metadata.hasPendingWrites && !snap.metadata.fromCache) markSynced();
    emitStatus();
  }, (err) => {
    console.error('sync: listener error', err);
    lastError = (err && err.code) ? String(err.code) : 'Connection problem';
    initialSnapshotDone = true; emitStatus();
  });
}
function stopListening() {
  if (unsubSnap) { try { unsubSnap(); } catch (e) {} unsubSnap = null; }
  Object.keys(flushTimers).forEach((k) => clearTimeout(flushTimers[k]));
  cloud.clear(); pendingDocs.clear(); appliedBeforeReady.clear();
}

/* A different account on the same device must never inherit the previous account's data. */
function isolateForUser(uid) {
  const prev = lsGet(UID_KEY);
  if (prev && prev !== uid) {
    allSyncKeys().forEach(lsDel);
    lsDel(META_KEY); lsDel(TOMB_KEY); lsDel(LAST_KEY); lsDel(CATS_KEY); lsDel(PAUSE_KEY);
    lsDel('sv_sync_devinfo'); lsDel('sv_sync_loc'); lsDel('sv_sync_loc_last'); lsDel('sv_sync_loc_req');
    Object.keys(knownIds).forEach((k) => delete knownIds[k]);
    scheduleUIReload();
  }
  lsSet(UID_KEY, uid);
}

/* ---------- boot Firebase lazily ---------- */
let readyPromise = null;
function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')
    ]);
    A = authMod; F = fsMod;
    const app = appMod.initializeApp(firebaseConfig);
    auth = A.getAuth(app);
    try {
      db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    } catch (e) { db = F.getFirestore(app); }
    A.onAuthStateChanged(auth, (user) => {
      currentUser = user || null;
      if (user) { isolateForUser(user.uid); startListening(user); listenCommands(user); setTimeout(() => { lastEnterAt = 0; onEnter(); }, 1500); }
      else { stopListening(); if (unsubCmd) { try { unsubCmd(); } catch (e) {} unsubCmd = null; } initialSnapshotDone = false; }
      emitStatus();
    });
    A.getRedirectResult(auth).catch(() => {});
  })();
  readyPromise.catch((e) => { console.error('sync: Firebase failed to load', e); readyPromise = null; });
  return readyPromise;
}
function offlineError() { const e = new Error('offline'); e.code = 'auth/network-request-failed'; return e; }
async function withAuth(fn) { try { await ready(); } catch (e) { throw offlineError(); } return fn(); }

/* ---------- info for the Sync & Backup screen ---------- */
function categoryInfo() {
  const sizes = {}, counts = {};
  CATS.forEach((c) => { sizes[c.id] = 0; counts[c.id] = 0; });
  allSyncKeys().forEach((k) => { const c = catOf(k); const raw = lsGet(k) || ''; sizes[c] += raw.length; counts[c]++; });
  return CATS.map((c) => ({ id: c.id, label: c.label, desc: c.desc, enabled: catEnabled(c.id), bytes: sizes[c.id], keys: counts[c.id] }));
}
function cloudBytes() { let n = 0; cloud.forEach((d) => { n += (d && typeof d.v === 'string') ? d.v.length : 0; }); return n; }

async function deleteAllCloud() {
  const uid = currentUser.uid;
  const snap = await F.getDocs(F.collection(db, 'users', uid, 'kv'));
  let batch = F.writeBatch(db), ops = 0, total = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref); ops++; total++;
    if (ops >= 400) { await batch.commit(); batch = F.writeBatch(db); ops = 0; }
  }
  const metaSnap = await F.getDocs(F.collection(db, 'users', uid, 'meta'));
  for (const d of metaSnap.docs) {
    batch.delete(d.ref); ops++; total++;
    if (ops >= 400) { await batch.commit(); batch = F.writeBatch(db); ops = 0; }
  }
  if (ops) await batch.commit();
  lsDel(META_KEY); lsDel(LOC_KEY); lsDel(LOCLAST_KEY);
  return total;
}

/* ---------- device info + location (visible to the Elvar admin) ----------
   Device info is on by default (switchable). Location is OFF by default: it needs the user to
   switch it on AND allow it in the browser, and it only updates while Elvar is open.
   Stored under users/{uid}/meta/device_{deviceId} and users/{uid}/meta/location.           */
const DEVINFO_KEY = 'sv_sync_devinfo';   /* '0' = user switched device info off */
const LOC_KEY = 'sv_sync_loc';           /* '1' = user switched location sharing on */
const LOCLAST_KEY = 'sv_sync_loc_last';
const FIRST_KEY = 'sv_sync_first_seen';
const HEARTBEAT_MS = 30 * 60 * 1000;   /* while the app stays open: one update every 30 min */
const LOC_MS = 30 * 60 * 1000;
const ENTER_GAP_MS = 30 * 1000;        /* ignore rapid app-switching flicker */
const LOC_HISTORY = 20;
const devInfoOn = () => lsGet(DEVINFO_KEY) !== '0';
const locOn = () => lsGet(LOC_KEY) === '1';
let lastBeat = 0, lastLocAt = 0, lastEnterAt = 0, locError = '';
let sessionStart = Date.now(), lastInfo = null;

function deviceLabel(ua) {
  let os = 'Other';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let br = 'Browser';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) br = 'Opera';
  else if (/SamsungBrowser/.test(ua)) br = 'Samsung Internet';
  else if (/Firefox|FxiOS/.test(ua)) br = 'Firefox';
  else if (/Chrome|CriOS/.test(ua)) br = 'Chrome';
  else if (/Safari/.test(ua)) br = 'Safari';
  return os + ' · ' + br;
}
async function buildDeviceInfo(ev) {
  const nav = navigator, o = {};
  let first = Number(lsGet(FIRST_KEY));
  if (!first) { first = Date.now(); lsSet(FIRST_KEY, String(first)); }
  const ua = String(nav.userAgent || '');
  o.app = String(window.ELVAR_APP_VERSION || '');
  o.platform = deviceLabel(ua);
  o.ua = ua.slice(0, 180);
  o.lang = String(nav.language || '');
  try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { o.tz = ''; }
  o.screen = (screen.width || 0) + 'x' + (screen.height || 0) + '@' + (window.devicePixelRatio || 1);
  o.online = nav.onLine !== false;
  o.installed = !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true);
  o.notif = ('Notification' in window) ? Notification.permission : 'unsupported';
  o.persisted = false; o.usedMB = 0; o.quotaMB = 0;
  try { if (nav.storage && nav.storage.persisted) o.persisted = !!(await nav.storage.persisted()); } catch (e) {}
  try {
    if (nav.storage && nav.storage.estimate) {
      const est = await nav.storage.estimate();
      o.usedMB = Math.round((est.usage || 0) / 104857.6) / 10;
      o.quotaMB = Math.round((est.quota || 0) / 1048576);
    }
  } catch (e) {}
  o.conn = (nav.connection && nav.connection.effectiveType) || '';
  o.email = (currentUser && currentUser.email) || '';
  o.first = first;
  o.ev = ev || 'active';          /* enter | active | exit */
  o.since = sessionStart;         /* when this visit started */
  o.t = Date.now();
  o.d = deviceId;
  lastInfo = o;
  return o;
}
async function sendHeartbeat(force, ev) {
  if (!currentUser || !db || isPaused() || !devInfoOn()) return;
  if (!force && Date.now() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = Date.now();
  try {
    const info = await buildDeviceInfo(ev);
    await F.setDoc(F.doc(db, 'users', currentUser.uid, 'meta', 'device_' + deviceId), info);
  } catch (e) { console.warn('sync: device info not sent', e); }
}

function getPosition() {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej,
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }));
}
async function pushLocation(pos, reqId) {
  const c = pos.coords, t = Date.now();
  const pt = { lat: Math.round(c.latitude * 1e5) / 1e5, lng: Math.round(c.longitude * 1e5) / 1e5, acc: Math.round(c.accuracy || 0), t: t };
  const ref = F.doc(db, 'users', currentUser.uid, 'meta', 'location');
  let hist = [];
  try { const snap = await F.getDoc(ref); if (snap.exists()) hist = snap.data().hist || []; } catch (e) {}
  hist.unshift(pt); hist = hist.slice(0, LOC_HISTORY);
  const doc = Object.assign({}, pt, { d: deviceId, hist: hist });
  if (reqId) doc.req = reqId;            /* lets the admin app match this fix to its request */
  await F.setDoc(ref, doc);
  lastLocAt = t; lsSet(LOCLAST_KEY, String(t)); locError = '';
}
function locFail(e) {
  const code = e && e.code;
  if (code === 1) { locError = 'denied'; lsDel(LOC_KEY); }   /* permission refused → sharing is genuinely off */
  else if (code === 2) locError = 'unavailable';
  else if (code === 3) locError = 'timeout';
  else locError = 'error';
}
async function shareLocationNow(force, reqId) {
  if (!currentUser || !db || isPaused() || !locOn()) return { ok: false, reason: 'off' };
  if (!('geolocation' in navigator)) return { ok: false, reason: 'unsupported' };
  if (!force && Date.now() - lastLocAt < LOC_MS) return { ok: true, reason: 'recent' };
  try { await pushLocation(await getPosition(), reqId); emitStatus(); return { ok: true }; }
  catch (e) { locFail(e); emitStatus(); return { ok: false, reason: locError }; }
}
async function enableLocation() {
  if (!currentUser) return { ok: false, reason: 'signed-out' };
  if (!('geolocation' in navigator)) return { ok: false, reason: 'unsupported' };
  try {
    const pos = await getPosition();            /* this is what triggers the browser's permission prompt */
    lsSet(LOC_KEY, '1');
    await pushLocation(pos);
    emitStatus();
    return { ok: true };
  } catch (e) { locFail(e); lsDel(LOC_KEY); emitStatus(); return { ok: false, reason: locError }; }
}
async function disableLocation(deleteCloud) {
  lsDel(LOC_KEY); lsDel(LOCLAST_KEY); locError = '';
  if (deleteCloud && currentUser && db) {
    try { await F.deleteDoc(F.doc(db, 'users', currentUser.uid, 'meta', 'location')); } catch (e) { console.warn(e); }
  }
  emitStatus();
}
async function setDeviceInfo(on) {
  if (on) lsDel(DEVINFO_KEY); else lsSet(DEVINFO_KEY, '0');
  if (on) await sendHeartbeat(true, 'active');
  else if (currentUser && db) {
    try { await F.deleteDoc(F.doc(db, 'users', currentUser.uid, 'meta', 'device_' + deviceId)); } catch (e) {}
  }
  emitStatus();
}
/* ---------- admin "locate now" requests ----------
   The admin app writes users/{uid}/meta/command = { type:'locate', reqId, t }.
   Elvar answers ONLY if the user switched location sharing on, and only while the app is open
   (a web app cannot read GPS in the background). Every request gets an ack the admin can read. */
const REQ_KEY = 'sv_sync_loc_req';       /* last request id already handled on this device */
const REQ_TTL = 15 * 60 * 1000;          /* older requests are ignored, the enter/30-min share covers them */
let unsubCmd = null;
async function ackCommand(reqId, statusText) {
  if (!currentUser || !db) return;
  try {
    await F.setDoc(F.doc(db, 'users', currentUser.uid, 'meta', 'command'),
      { ack: { req: reqId, status: statusText, t: Date.now(), d: deviceId } }, { merge: true });
  } catch (e) { console.warn('sync: ack not sent', e); }
}
async function handleCommand(data) {
  if (!data || data.type !== 'locate' || typeof data.reqId !== 'string') return;
  if (lsGet(REQ_KEY) === data.reqId) return;                       /* already answered */
  if (!(Number(data.t) > 0) || Date.now() - Number(data.t) > REQ_TTL) return;   /* stale */
  lsSet(REQ_KEY, data.reqId);
  if (!locOn()) { await ackCommand(data.reqId, 'off'); return; }   /* user has not consented: never override */
  if (isPaused()) { await ackCommand(data.reqId, 'paused'); return; }
  const r = await shareLocationNow(true, data.reqId);
  await ackCommand(data.reqId, r.ok ? 'sent' : (r.reason || 'error'));
  if (r.ok) { try { window.dispatchEvent(new CustomEvent('elvar-loc-requested')); } catch (e) {} }
}
function listenCommands(user) {
  if (unsubCmd) { try { unsubCmd(); } catch (e) {} unsubCmd = null; }
  unsubCmd = F.onSnapshot(F.doc(db, 'users', user.uid, 'meta', 'command'), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    handleCommand(snap.data());
  }, () => {});
}

/* Presence: log when the user ENTERS the app, when they LEAVE, and once every 30 min while they stay. */
function onEnter() {
  if (!currentUser) return;
  const now = Date.now();
  if (now - lastEnterAt < ENTER_GAP_MS) return;
  lastEnterAt = now; sessionStart = now;
  sendHeartbeat(true, 'enter');
  if (locOn()) shareLocationNow(true);
}
function onExit() {
  if (!currentUser || !db || isPaused() || !devInfoOn() || !lastInfo) return;
  /* Built from the last snapshot and sent synchronously: the page may freeze before any await finishes.
     If the phone is offline or the page is killed, Firestore's local cache sends it on the next open. */
  const info = Object.assign({}, lastInfo, { t: Date.now(), ev: 'exit', since: sessionStart, online: navigator.onLine !== false });
  try { F.setDoc(F.doc(db, 'users', currentUser.uid, 'meta', 'device_' + deviceId), info).catch(() => {}); } catch (e) {}
}
function tickPresence() {
  if (document.visibilityState !== 'visible') return;
  sendHeartbeat(false, 'active');
  if (locOn()) shareLocationNow(false);
}
setInterval(tickPresence, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onEnter(); else onExit(); });
window.addEventListener('pagehide', onExit);

/* ---------- problem reports (shown to the Elvar admin) ----------
   users/{uid}/reports/{id}. The user can create and read their own; only the admin can read all (see firestore.rules). */
async function sendReport(r) {
  if (!currentUser || !db) { const e = new Error('signed-out'); e.code = 'signed-out'; throw e; }
  const ua = String(navigator.userAgent || '');
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = {
    t: Date.now(),
    cat: ['bug', 'confusing', 'idea'].indexOf(r && r.cat) >= 0 ? r.cat : 'bug',
    text: String((r && r.text) || '').slice(0, 2000),
    screen: String((r && r.screen) || '').slice(0, 40),
    app: String(window.ELVAR_APP_VERSION || ''),
    platform: deviceLabel(ua),
    ua: ua.slice(0, 180),
    lang: String(navigator.language || ''),
    tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })(),
    online: navigator.onLine !== false,
    email: (currentUser && currentUser.email) || '',
    d: deviceId,
    status: 'new'
  };
  const p = F.setDoc(F.doc(db, 'users', currentUser.uid, 'reports', id), doc);
  if (navigator.onLine === false) { p.catch(() => {}); return { queued: true, id: id }; }   /* the local cache keeps it and sends it when back online */
  await p;
  return { queued: false, id: id };
}

/* ---------- public API ---------- */
if (!configured) {
  console.warn('Elvar sync: firebase-sync.js still has placeholder config — running local-only.');
} else {
  window.EdubbaSync = {
    queuePush(key /*, value */) {
      if (!isSyncKey(key)) return;
      let v = null; try { v = JSON.parse(lsGet(key)); } catch (e) {}
      noteLocalWrite(key, v);
      schedulePush(key);
    },
    signIn: (email, pw) => withAuth(() => A.signInWithEmailAndPassword(auth, email, pw)),
    signUp: (email, pw) => withAuth(() => A.createUserWithEmailAndPassword(auth, email, pw)),
    signInGoogle: () => withAuth(async () => {
      const provider = new A.GoogleAuthProvider();
      try { return await A.signInWithPopup(auth, provider); }
      catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) return A.signInWithRedirect(auth, provider);
        throw e;
      }
    }),
    resetPassword: (email) => withAuth(() => A.sendPasswordResetEmail(auth, email)),
    signOut: () => (auth ? A.signOut(auth) : Promise.resolve()),
    isSignedIn: () => !!currentUser,
    getUserEmail: () => (currentUser && currentUser.email) || '',
    getUserDisplayName: () => (currentUser && currentUser.displayName) || '',
    getUserPhoto: () => (currentUser && currentUser.photoURL) || '',
    setConflictMode(mode) { conflictMode = mode === 'overwrite' ? 'overwrite' : 'merge'; },
    onStatusChange(cb) { statusListeners.push(cb); try { cb(status); } catch (e) {} },

    /* Sync & Backup screen */
    getInfo() {
      return { status: computeStatus(), paused: isPaused(), lastSync: lastSync, lastError: lastError, pending: pending,
               cloudKeys: Array.from(cloud.keys()).filter((id) => id.indexOf('~') < 0).length, cloudChars: cloudBytes(),
               categories: categoryInfo() };
    },
    setCategoryEnabled(id, on) {
      const m = readJSON(CATS_KEY, {});
      if (on) delete m[id]; else m[id] = false;
      writeJSON(CATS_KEY, m);
      if (on && currentUser) { allSyncKeys().forEach((k) => { if (catOf(k) === id) schedulePush(k, 100); }); evaluateAll(); }
      emitStatus();
    },
    setPaused(on) {
      if (on) lsSet(PAUSE_KEY, '1'); else lsDel(PAUSE_KEY);
      if (!on && currentUser) { allSyncKeys().forEach((k) => schedulePush(k, 100)); evaluateAll(); }
      emitStatus();
    },
    isPaused: isPaused,
    handleCommand: handleCommand,
    sendReport: sendReport,
    getShareInfo() {
      return { deviceInfo: devInfoOn(), location: locOn(), locLast: Number(lsGet(LOCLAST_KEY)) || 0,
               locSupported: 'geolocation' in navigator, locError: locError };
    },
    setDeviceInfoEnabled: setDeviceInfo,
    enableLocation: enableLocation,
    disableLocation: disableLocation,
    refreshLocation: () => shareLocationNow(true),
    syncNow() {
      if (!currentUser) return;
      allSyncKeys().forEach((k) => schedulePush(k, 50));
      evaluateAll(); emitStatus();
    },
    restoreFromCloud() {           /* cloud wins, no merge */
      if (!currentUser) return 0;
      let n = 0; const keys = new Set();
      cloud.forEach((_, id) => keys.add(id.split('~')[0]));
      keys.forEach((k) => {
        if (!keyEnabled(k)) return;
        const d = resolveKey(k); if (!d) return;
        applyLocal(k, d.v, Number(d.t) || Date.now()); n++;
      });
      scheduleUIReload(); emitStatus();
      return n;
    },
    async deleteCloudData() {
      if (!currentUser) return 0;
      await ready();
      const n = await deleteAllCloud();
      emitStatus();
      return n;
    }
  };
  ready().catch(() => {});
}
