/* Elvar push reminders — makes timed reminders reach the phone's notification panel on time, even with the app closed.
   Add ONE line to index.html, after the elvar-admin-link.js line:
     <script type="module" src="elvar-push.js"></script>
   How it works: this file saves your upcoming timed reminders (custom reminders, note reminders, exam heads-up and
   exam start) to your own Firestore document pushQueue/{uid}. A free Cloudflare worker looks at that every minute and
   sends a push through Firebase Cloud Messaging when one is due. sw.js shows it. Nothing here can break Elvar:
   if anything fails, the app keeps working exactly as before. */

/* Paste your Web Push certificate key here (Firebase console > Project settings > Cloud Messaging > Web Push certificates). */
const VAPID_KEY = 'BKqFJaeHp39ErPTHqjddwxB62QfgWDnxlSpXPCm7WK7cjvnYQiMSAyMuUhXxvkQAPRwZfUbFVMYWTFBD0y1MwwA';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const W = window;
const DAYS_AHEAD = 14, MAX_ITEMS = 120, HEADSUP_MS = 60 * 60000;

if (!/^YOUR_/.test(VAPID_KEY) && 'serviceWorker' in navigator && typeof Notification !== 'undefined') {
  try { await main(); } catch (e) { console.warn('Elvar push: not started', e); }
}

async function main() {
  const [{ getApps }, { getAuth, onAuthStateChanged }, F, M] = await Promise.all(
    ['app', 'auth', 'firestore', 'messaging'].map((m) => import(SDK + 'firebase-' + m + '.js')));
  if (!(await M.isSupported())) return;          /* e.g. iPhone before the app is added to the Home Screen */

  let app;
  for (let i = 0; i < 80 && !(app = getApps()[0]); i++) await new Promise((r) => setTimeout(r, 500));
  if (!app) return;
  const auth = getAuth(app), db = F.getFirestore(app), messaging = M.getMessaging(app);

  let token = '', lastSig = '', lastWrite = 0, busy = false;
  const ref = () => F.doc(db, 'pushQueue', auth.currentUser.uid);

  /* ---- 1) this phone's push address ---- */
  async function ensureToken() {
    if (Notification.permission !== 'granted') return '';
    if (token) return token;
    const reg = await navigator.serviceWorker.ready;
    token = (await M.getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg })) || '';
    if (token) await F.setDoc(ref(), { tokens: F.arrayUnion(token), t: Date.now() }, { merge: true });
    return token;
  }

  /* ---- 2) the reminders coming up ----
     Three families:
     - exams with a clock time: a heads-up one hour before and the start alert. They share ONE notification, and the
       words are written by the phone at the moment of delivery from the real clock (30 min left, started at 10:00 ...).
       Nothing is shown more than 90 minutes after the start.
     - custom and note reminders: must arrive on the same day; a late one says when it was due.
     - day-based nudges (streak, streak at risk, overdue session, main-exam countdown, mock-exam notice): sent at a
       fixed hour of the day; dropped at midnight; cancelled when the app sees you already did the thing. */
  const typeOn = (k) => { try { return !W.notifTypeEnabled || W.notifTypeEnabled[k] !== false; } catch (e) { return true; } };
  const parseLocal = (s) => { const d = new Date(s); return isNaN(d) ? 0 : d.getTime(); };   /* 'YYYY-MM-DDTHH:MM' = phone's own clock */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dayAt = (k, h, m) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + k, h, m, 0, 0); };
  const endOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime() - 1; };
  function upcoming() {
    const now = Date.now(), end = now + DAYS_AHEAD * 86400000, out = [];
    const add = (id, at, title, body, kind, rawId, extra) => {
      if (at > now + 5000 && at < end && title) out.push(Object.assign({ id: String(id), at: Math.round(at), title: String(title), body: String(body || ''), kind, rawId: rawId == null ? '' : String(rawId), until: endOfDay(at) }, extra || {}));
    };
    const call = (fn, d) => { try { return typeof W[fn] === 'function' ? W[fn].apply(null, d || []) : null; } catch (e) { return null; } };

    /* custom + note reminders (same day; late ones are labelled) */
    if (typeOn('custom')) (W.customNotifs || []).forEach((r) => { if (r && r.when) { const at = parseLocal(r.when); add('custom-' + r.id, at, r.title, r.desc || 'Reminder', 'custom', r.id, { late: 1, hm: pad(new Date(at).getHours()) + ':' + pad(new Date(at).getMinutes()) }); } });
    if (typeOn('note')) (W.todos || []).forEach((t) => {
      if (!t || !t.reminderAt || t.archived || t.deletedAt) return;
      const nb = t.note ? String(t.note).replace(/<[^>]*>/g, '').slice(0, 60) : '', at = parseLocal(t.reminderAt);
      add('note-' + t.id, at, t.text || 'Note reminder', nb || 'Reminder', 'note', t.id, { late: 1, hm: pad(new Date(at).getHours()) + ':' + pad(new Date(at).getMinutes()) });
    });

    /* exams with a time: heads-up + start (one notification, words made at delivery) */
    (W.exams || []).forEach((e) => {
      if (!e || !e.time || !e.date || e.done || e.skipped) return;
      const main = e.kind === 'main', kind = main ? 'maincd' : 'exam';
      if (!typeOn(kind)) return;
      const tm = String(e.time).slice(0, 5), st = parseLocal(e.date + 'T' + tm);
      const ex = { n: e.name + (main ? '' : ' (Mock)'), tm, w: e.location ? ' \u00B7 ' + e.location : '', st };
      const tag = 'edubba-' + kind + '-time-' + e.id;
      const lim = { until: st + 90 * 60000 };
      add(kind + '-soon-' + e.id, st - HEADSUP_MS, ex.n, '', kind, e.id, Object.assign({ ex, exk: 'soon', tag, renotify: 1 }, lim));
      add(kind + '-now-' + e.id, st, ex.n, '', kind, e.id, Object.assign({ ex, exk: 'now', tag, renotify: 1 }, lim));
    });

    /* main exam: the daily countdown, 8:00 on each day it applies */
    if (typeOn('maincd')) (W.exams || []).forEach((e) => {
      if (!e || e.kind !== 'main' || e.done || e.skipped) return;
      const D = call('daysUntil', [e.date]); if (D == null) return;
      const lead = (e.remindDays && e.remindDays > 3) ? e.remindDays : null;
      for (let k = 0; k <= 13; k++) {
        const d = D - k; if (d < 0) break;
        const day = dayAt(k, 8, 0);
        if (!(d <= 3 || d === lead || (e.remindDate && e.remindDate === ymd(day)))) continue;
        const title = d === 0 ? e.name + ' is today' : d === 1 ? e.name + ' is tomorrow' : d + ' days until ' + e.name;
        let body = d === 0 ? "Good luck \u2014 you've prepared for this" : d <= 3 ? 'Final stretch \u2014 revise, rest, stay calm' : 'Plan your remaining revision';
        if (e.time) body = e.time + ' \u00B7 ' + body;
        add('maincd-' + e.id + '-' + d, day.getTime(), title, body, 'maincd', e.id);
      }
    });

    /* mock exam notice: 8:00 on the first day it is inside the "remind me" window */
    if (typeOn('exam')) (W.exams || []).forEach((e) => {
      if (!e || e.kind === 'main' || e.done || e.skipped || !e.date) return;
      const D = call('daysUntil', [e.date]); if (D == null) return;
      const lead = +W.notifExamLeadDays || 3, k = D - lead;
      if (k >= 0) add('exam-' + e.id, dayAt(k, 8, 0).getTime(), e.name + ' (Mock)', e.location || 'Exam', 'exam', e.id);
    });

    /* sessions due: 8:00 on the day they are due */
    if (typeOn('overdue')) (W.scheduled || []).forEach((s) => {
      if (!s || s.done || !s.date) return;
      const d = call('daysUntil', [s.date]); if (d == null || d < 0 || d > 2) return;
      add('sched-' + s.id, dayAt(d, 8, 0).getTime(), s.subject + ' \u2014 ' + (s.type === 'revision' ? 'Revision' : 'Study') + ' due today', s.topic || '', 'overdue', s.id);
    });

    /* streak: nudge at 18:00 (today and the next two days), "about to break" at 21:00 today.
       Both share one notification per day. Logging a session cancels them as soon as the app syncs. */
    const activeToday = !!call('hasActivityToday'), streak = +call('computeStreak') || 0;
    for (let k = 0; k <= 2; k++) {
      const day = dayAt(k, 18, 0), ds = ymd(day);
      if (typeOn('streak') && !(k === 0 && activeToday))
        add('streak-' + ds, day.getTime(), "You haven't logged a session today", 'Keep your streak going \u2014 even a short one counts', 'streak', '', { tag: 'edubba-streak-day-' + ds });
      if (k === 0 && typeOn('streakrisk') && streak > 0 && !activeToday)
        add('streakrisk-' + ds, dayAt(0, 21, 0).getTime(), 'Your ' + streak + '-day streak ends at midnight', 'Log a session or an MCQ set to keep it alive', 'streakrisk', '', { tag: 'edubba-streak-day-' + ds, renotify: 1 });
    }

    out.sort((a, b) => a.at - b.at);
    return out.slice(0, MAX_ITEMS);
  }
  function quietInfo() { return (W.quietOn ? '1' : '0') + '|' + (W.quietFrom || '22:00') + '|' + (W.quietTo || '07:00'); }   /* the app's own Quiet Hours settings */

  /* ---- 3) save them (only when something changed) ---- */
  async function sync(force) {
    if (busy || !auth.currentUser) return;
    busy = true;
    try {
      if (!(await ensureToken())) return;
      const items = upcoming(), quiet = quietInfo();
      const sig = JSON.stringify(items) + quiet + token;
      if (!force && sig === lastSig) return;
      if (Date.now() - lastWrite < 15000) return;
      await F.setDoc(ref(), { q: JSON.stringify(items), nextAt: items.length ? items[0].at : 99999999999999, quiet, t: Date.now() }, { merge: true });
      lastSig = sig; lastWrite = Date.now();
    } catch (e) { console.warn('Elvar push: sync failed', e); }
    finally { busy = false; }
  }

  /* ---- 4) when to sync ---- */
  onAuthStateChanged(auth, (u) => { token = ''; lastSig = ''; if (u) setTimeout(() => sync(true), 2500); });
  setInterval(() => { if (document.visibilityState === 'visible') sync(false); }, 20000);
  document.addEventListener('visibilitychange', () => { sync(document.visibilityState === 'hidden'); });
  window.addEventListener('pagehide', () => sync(true));
  window.addEventListener('online', () => sync(true));

  /* ---- 5) sign out: this phone stops receiving this account's reminders ---- */
  const S = W.EdubbaSync;
  if (S && S.signOut) {
    const orig = S.signOut;
    S.signOut = async function () {
      try { if (token && auth.currentUser) await F.setDoc(ref(), { tokens: F.arrayRemove(token), t: Date.now() }, { merge: true }); } catch (e) {}
      token = '';
      return orig.apply(this, arguments);
    };
  }
}
