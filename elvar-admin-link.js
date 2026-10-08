/* Elvar <-> admin app link. Add ONE line to the main app, right after the firebase-sync.js line:
     <script type="module" src="elvar-admin-link.js"></script>
   It uses the same Firebase app that firebase-sync.js creates and never blocks Elvar: if anything fails, Elvar works as before.
   Everything that reports about the student follows the "Device info" switch in Sync & Backup (sv_sync_devinfo). */
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const [{ getApps }, { getAuth, onAuthStateChanged }, F] = await Promise.all(['app', 'auth', 'firestore'].map(m => import(SDK + 'firebase-' + m + '.js')));
let app; for (let i = 0; i < 80 && !(app = getApps()[0]); i++) await new Promise(r => setTimeout(r, 500));
if (app) {
  const auth = getAuth(app), db = F.getFirestore(app), W = window;
  const ls = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const on = () => ls('sv_sync_devinfo') !== '0', today = () => new Date().toISOString().slice(0, 10), uid = () => auth.currentUser && auth.currentUser.uid;
  let buf = { ms: 0, opens: 1, logins: 0, feat: {} }, loginPending = false, started = false, marked = '', cfg = {};

  /* usage per day: time while visible, opens, logins, page visits */
  setInterval(() => { if (document.visibilityState === 'visible') buf.ms += 10000; }, 10000);
  ['signIn', 'signUp', 'signInGoogle'].forEach(k => { const s = W.EdubbaSync; if (s && s[k]) { const o = s[k]; s[k] = function () { loginPending = true; return o.apply(this, arguments); }; } });
  if (typeof W.goTo === 'function') {
    const g = W.goTo;
    W.goTo = function (n) {
      if ((cfg.locked || []).indexOf(n) > -1) { try { W.toast(cfg.lockMsg || 'This page is temporarily unavailable.'); } catch (e) {} return; }
      try { buf.feat[n] = (buf.feat[n] || 0) + 1; } catch (e) {}
      return g.apply(this, arguments);
    };
  }
  async function flush() {
    const u = uid(); if (!u || !on() || (!buf.ms && !buf.opens && !buf.logins && !Object.keys(buf.feat).length)) return;
    const b = buf; buf = { ms: 0, opens: 0, logins: 0, feat: {} }; const f = {}; for (const k in b.feat) f[k] = F.increment(b.feat[k]);
    try { await F.setDoc(F.doc(db, 'users', u, 'meta', 'usage'), { last: Date.now(), days: { [today()]: { ms: F.increment(b.ms), opens: F.increment(b.opens), logins: F.increment(b.logins), feat: f } } }, { merge: true }); }
    catch (e) { buf.ms += b.ms; buf.opens += b.opens; buf.logins += b.logins; for (const k in b.feat) buf.feat[k] = (buf.feat[k] || 0) + b.feat[k]; }
  }
  async function summary() {
    const u = auth.currentUser; if (!u || !on()) return;
    try { await F.setDoc(F.doc(db, 'users', u.uid), { name: String(W.profileName || u.displayName || ''), cls: String(W.profileClass || ''), grp: String(W.profileGroup || ''), inst: String(W.profileInstitute || ''), email: u.email || '', streak: (typeof W.computeStreak === 'function' ? W.computeStreak() : 0) || 0, last: Date.now(), ver: String(W.ELVAR_APP_VERSION || '') }); } catch (e) {}
  }
  async function daily() { const u = uid(); if (!u || !on() || marked === today()) return; marked = today(); try { await F.setDoc(F.doc(db, 'daily', today()), { uids: { [u]: true } }, { merge: true }); } catch (e) { marked = ''; } }

  /* notifications from the admin app (everyone + this student). A message with a future sentAt waits until its time. */
  let cbs = [], bc = [], dm = [], unsubs = [];
  const mk = (p, d) => ({ id: p + d.id, title: d.title, body: d.body, screen: d.screen || null, sentAt: d.sentAt, expiresAt: d.expiresAt });
  const emit = () => { const now = Date.now(), list = bc.concat(dm).filter(m => !m.sentAt || Date.parse(m.sentAt) <= now); cbs.forEach(cb => { try { cb(list); } catch (e) {} }); };
  setInterval(emit, 60000);
  function attach(u) {
    unsubs.forEach(x => x()); unsubs = [];
    /* the app may replace its local data with the account's cloud copy a few seconds after sign-in; say it again afterwards so nothing is lost */
    [5000, 12000, 25000].forEach(t => setTimeout(emit, t));
    unsubs.push(F.onSnapshot(F.collection(db, 'broadcasts'), s => { bc = s.docs.map(d => mk('b-', { id: d.id, ...d.data() })); emit(); }, () => {}));
    unsubs.push(F.onSnapshot(F.collection(db, 'users', u.uid, 'messages'), s => { dm = s.docs.map(d => mk('m-', { id: d.id, ...d.data() })); emit(); }, () => {}));
  }
  W.elvarRemote = { subscribe(cb) { cbs.push(cb); } };
  try { if (typeof W.initRemoteNotifications === 'function') W.initRemoteNotifications(); } catch (e) {}

  /* maintenance, minimum version, locked pages (set from the admin app, Releases) */
  function gate() {
    let o = document.getElementById('admGate'); const v = String(W.ELVAR_APP_VERSION || '0');
    const need = cfg.minVersion && typeof W.cmpVersion === 'function' && W.cmpVersion(v, cfg.minVersion) < 0, msg = cfg.maintenance ? (cfg.lockMsg || 'Elvar is being improved. Back soon.') : need ? 'A required update is available.' : '';
    if (!msg) { if (o) o.remove(); return; }
    if (!o) { o = document.createElement('div'); o.id = 'admGate'; o.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center;font-family:inherit'; document.body.appendChild(o); }
    o.innerHTML = '<div style="font-size:1.4rem;font-weight:800">' + (cfg.maintenance ? 'Maintenance' : 'Update required') + '</div><div style="font-size:.9rem;color:var(--muted-light);max-width:300px"></div>' + (need && !cfg.maintenance ? '<button class="btn btn-p" style="width:auto;padding:12px 22px" onclick="location.href=location.pathname+\'?v=\'+Date.now()">Update now</button>' : '');
    o.children[1].textContent = msg;
  }
  F.onSnapshot(F.doc(db, 'config', 'app'), s => { cfg = s.exists() ? s.data() : {}; gate(); }, () => {});

  /* error reports (at most 5 per session, same message once) */
  const sent = new Set();
  function report(msg, stack) {
    const u = uid(); msg = String(msg || '').slice(0, 300); if (!u || !msg || sent.has(msg) || sent.size >= 5) return; sent.add(msg);
    F.addDoc(F.collection(db, 'errors'), { uid: u, msg, stack: String(stack || '').slice(0, 800), screen: String(W.curScreen || ''), ver: String(W.ELVAR_APP_VERSION || ''), at: Date.now() }).catch(() => {});
  }
  addEventListener('error', e => report(e.message, e.error && e.error.stack));
  addEventListener('unhandledrejection', e => report(e.reason && (e.reason.message || e.reason), e.reason && e.reason.stack));

  onAuthStateChanged(auth, u => {
    if (!u) { unsubs.forEach(x => x()); unsubs = []; bc = []; dm = []; try { emit(); } catch (e) {} return; }   /* another person may sign in on this phone: drop the last person's messages */
    if (loginPending) { buf.logins++; loginPending = false; }
    if (!started) { started = true; setInterval(flush, 60000); setInterval(summary, 600000); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flush(); summary(); } }); }
    daily(); summary(); flush(); attach(u);
  });
}
