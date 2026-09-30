/* Homebase front end (app.js), Phase 1.1 (speed update) */
'use strict';

/* ================= Config comes from config.js ================= */
const CONFIG = window.HB_CONFIG || {};

/* ================= Constants ================= */
const TYPES = {
  upkeep: { label: 'Upkeep', plural: 'Upkeep', hint: 'Aircon cleaning, grease trap, deep clean' },
  bill: { label: 'Bill', plural: 'Bills', hint: 'Condo dues, electricity, internet' },
  event: { label: 'Event', plural: 'Events', hint: 'Birthdays, anniversaries, family dates' },
  task: { label: 'Task', plural: 'Tasks', hint: 'Anything else with a date' },
};
const FREQ = { weekly: ['week', 'weeks'], monthly: ['month', 'months'], quarterly: ['quarter', 'quarters'], yearly: ['year', 'years'] };
const EVENT_HORIZON_DAYS = 30;   // events show in Upcoming only when this close
const REQUEST_TIMEOUT_MS = 45000;
const LOCAL_DATA_KEY = 'hb_data';
const ICON = {
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

/* ================= State ================= */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage full or unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
};

const S = {
  token: null,
  claims: null,
  data: null,
  fromLocal: false,     // true while showing the saved copy, before the server replies
  syncedAt: 0,          // when the server last confirmed the data
  timing: null,         // last request timing, shown in More > Account
  tab: 'upcoming',
  who: store.get('hb_who') === 'mine' ? 'mine' : 'all',
  typeFilter: 'all',
  cal: { mode: 'month', cursor: null, selected: null },
  bills: { period: 'month', cursor: null, cats: [] },
  selecting: false,
  picked: new Set(),
  busy: 0,
  hashOpened: false,
};

/* ================= Small helpers ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const toD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromD = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return fromD(d); };
const diffDays = (a, b) => Math.round((toD(b) - toD(a)) / 864e5);
const monthStart = (s) => s.slice(0, 8) + '01';
const monthEnd = (s) => { const [y, m] = s.split('-').map(Number); return fromD(new Date(Date.UTC(y, m, 0))); };
const addMonths = (s, n) => { const [y, m] = s.split('-').map(Number); return fromD(new Date(Date.UTC(y, m - 1 + n, 1))); };
const weekStart = (s) => addDays(s, -toD(s).getUTCDay()); // Sunday

function clampMD(y, md) {
  const [m, d] = md.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(d, last))}`;
}

function nextFixed(s, freq, interval, anchorDay) {
  const n = Math.max(1, Number(interval) || 1);
  if (freq === 'weekly') return addDays(s, 7 * n);
  const months = freq === 'quarterly' ? 3 * n : freq === 'yearly' ? 12 * n : n;
  const [y0, m0, d0] = s.split('-').map(Number);
  const total = (m0 - 1) + months;
  const y = y0 + Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${pad(m + 1)}-${pad(Math.min(Number(anchorDay) || d0, last))}`;
}

const fmt = (s, o) => toD(s).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const fmtShort = (s) => fmt(s, { month: 'short', day: 'numeric' });
const fmtLong = (s) => fmt(s, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''}${h >= 12 ? 'pm' : 'am'}`;
}
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function peso(n) {
  const v = Number(n) || 0;
  const dec = Math.round(v * 100) % 100 ? 2 : 0;
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function rel(s) {
  const d = diffDays(today(), s);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`;
  if (d < 7) return fmt(s, { weekday: 'long' });
  return `In ${d} days`;
}

/* ================= Data accessors ================= */
const me = () => S.data.me.email;
const isAdmin = () => S.data.me.role === 'admin';
const itemById = (id) => S.data.items.find((i) => i.id === id);
const assignees = (i) => String(i.assignees || '').split(',').filter(Boolean);
const activeUsers = () => S.data.users.filter((u) => u.status !== 'removed')
  .sort((a, b) => displayName(a.email).localeCompare(displayName(b.email)));

function displayName(email) {
  const u = S.data.users.find((x) => x.email === email);
  return (u && u.name) || String(email).split('@')[0];
}
function initials(email) {
  const n = displayName(email).trim();
  const parts = n.split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function avatar(email) {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="av av-${h % 5}" title="${esc(displayName(email))}">${esc(initials(email))}</span>`;
}
function canComplete(i) {
  if (i.type === 'event' || i.status !== 'active') return false;
  const a = assignees(i);
  return isAdmin() || !a.length || a.includes(me());
}

/** Where an item currently sits on the timeline, and what to say about it. */
function view(i) {
  const t = today();
  if (i.type === 'event') {
    let date = clampMD(Number(t.slice(0, 4)), i.eventDate.slice(5));
    if (date < t) date = clampMD(Number(t.slice(0, 4)) + 1, i.eventDate.slice(5));
    return { date, time: '', stage: '', note: eventNote(i, date) };
  }
  if (i.flow === 'two' && i.stage === 'booked' && i.apptDate) {
    return { date: i.apptDate, time: i.apptTime, stage: 'booked', note: `Booked${i.vendorName ? ' with ' + i.vendorName : ''}` };
  }
  if (i.flow === 'two') {
    return { date: addDays(i.dueDate, -(Number(i.leadDays) || 0)), time: '', stage: 'to_book', note: `Book the vendor. Service due ${fmtShort(i.dueDate)}` };
  }
  return { date: i.dueDate, time: i.dueTime, stage: '', note: '' };
}

function eventNote(i, date) {
  if (i.showYears !== 'yes') return '';
  const n = Number(date.slice(0, 4)) - Number(i.eventDate.slice(0, 4));
  if (n <= 0) return '';
  if (i.eventKind === 'birthday') return `Turns ${n}`;
  if (i.eventKind === 'anniversary') return `${ordinal(n)} anniversary`;
  return `${n} year${n === 1 ? '' : 's'}`;
}

function describeRecur(i) {
  if (i.type === 'event') return 'Every year';
  if (i.recurMode === 'fixed') {
    const n = Number(i.interval) || 1;
    const unit = FREQ[i.freq] || FREQ.monthly;
    return `Every ${n > 1 ? n + ' ' + unit[1] : unit[0]}, counted from the due date`;
  }
  if (i.recurMode === 'after') return `${i.afterDays} days after it's done`;
  return "Doesn't repeat";
}

function filteredItems() {
  let items = S.data.items.filter((i) => i.status === 'active');
  if (S.who === 'mine') items = items.filter((i) => assignees(i).includes(me()));
  if (S.typeFilter !== 'all') items = items.filter((i) => i.type === S.typeFilter);
  return items;
}

/** Every date an item lands on within [start, end]. Later schedule dates are marked as projected. */
function occurrences(i, start, end) {
  const out = [];
  if (i.type === 'event') {
    for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
      const d = clampMD(y, i.eventDate.slice(5));
      if (d >= start && d <= end && d >= i.eventDate) out.push({ item: i, date: d, time: '', note: eventNote(i, d) });
    }
    return out;
  }
  const v = view(i);
  if (v.date >= start && v.date <= end) out.push({ item: i, ...v });
  if (i.recurMode === 'fixed' && i.flow !== 'two') {
    let d = i.dueDate;
    for (let k = 0; k < 500; k++) {
      d = nextFixed(d, i.freq, i.interval, i.anchorDay);
      if (d > end) break;
      if (d >= start) out.push({ item: i, date: d, time: i.dueTime, note: '', projected: true });
    }
  }
  return out;
}

function occMap(start, end) {
  const map = {};
  filteredItems().forEach((i) => occurrences(i, start, end).forEach((o) => { (map[o.date] = map[o.date] || []).push(o); }));
  Object.values(map).forEach((list) => list.sort(sortOcc));
  return map;
}
function sortOcc(a, b) {
  return a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99') || a.item.title.localeCompare(b.item.title);
}

/* ================= Saved copy on this device ================= */
function saveLocal(d) {
  store.set(LOCAL_DATA_KEY, JSON.stringify({ email: d.me.email, savedAt: Date.now(), data: d }));
}
function loadLocal(email) {
  try {
    const j = JSON.parse(store.get(LOCAL_DATA_KEY) || 'null');
    if (j && j.data && email && j.email === String(email).toLowerCase()) return j;
  } catch (e) { /* ignore a corrupt copy */ }
  return null;
}

/* ================= API ================= */
async function api(action, payload = {}, opts = {}) {
  await ensureFreshToken();
  setBusy(1);
  const t0 = performance.now();
  try {
    const attempts = opts.retry ? 2 : 1;
    let lastErr;
    for (let n = 0; n < attempts; n++) {
      try {
        const j = await postOnce(action, payload);
        S.timing = { action, totalMs: Math.round(performance.now() - t0), server: j.ms || null };
        console.info('[Homebase]', action, S.timing);
        if (!j.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { code: j.code });
        return j.data;
      } catch (e) {
        lastErr = e;
        if (e.code !== 'NETWORK' && e.code !== 'TIMEOUT') throw e;
      }
    }
    throw lastErr;
  } finally {
    setBusy(-1);
  }
}

async function postOnce(action, payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
      body: JSON.stringify({ action, payload, token: S.token }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Homebase took too long to respond. Try again.'), { code: 'TIMEOUT' });
    throw Object.assign(new Error("Couldn't reach Homebase. Check your connection and try again."), { code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
  }
  try {
    return await res.json();
  } catch (e) {
    throw Object.assign(new Error('Homebase sent an unexpected reply. Check that the Apps Script deployment is set to "Anyone".'), { code: 'BAD_REPLY' });
  }
}

async function mutate(action, payload, doneMsg) {
  try {
    setData(await api(action, payload));
    if (doneMsg) toast(doneMsg);
    return true;
  } catch (e) {
    handleErr(e);
    return false;
  }
}

function setData(d, fromLocal = false) {
  S.data = d;
  S.fromLocal = fromLocal;
  if (!fromLocal) { S.syncedAt = Date.now(); saveLocal(d); }
  if (!S.cal.cursor) { S.cal.cursor = today(); S.cal.selected = today(); }
  if (!S.bills.cursor) S.bills.cursor = today();
  S.picked.forEach((id) => { const i = itemById(id); if (!i || !canComplete(i)) S.picked.delete(id); });
  render();
}

function handleErr(e) {
  if (e.code === 'AUTH') { signOut(e.message, { keepLocal: true }); return; }
  if (e.code === 'NOT_INVITED') { signOut(e.message); return; }
  toast(e.message, true);
}

function setBusy(delta) {
  S.busy = Math.max(0, S.busy + delta);
  $('#busy').hidden = S.busy === 0;
  document.querySelectorAll('.sheet button[type=submit], .sheet [data-busy]').forEach((b) => { b.disabled = S.busy > 0; });
}

let toastTimer;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 5000 : 2600);
}

/* ================= Auth (Google Identity Services) ================= */
function decodeJwt(t) {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(atob(b).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
  } catch (e) { return null; }
}

let gsiReady = false;
let pendingToken = null;

function whenGsi(cb) {
  if (window.google && google.accounts && google.accounts.id) {
    if (!gsiReady) {
      google.accounts.id.initialize({
        client_id: CONFIG.CLIENT_ID,
        callback: onCredential,
        auto_select: true,
        itp_support: true,
        use_fedcm_for_prompt: true,
      });
      gsiReady = true;
    }
    cb();
  } else {
    setTimeout(() => whenGsi(cb), 150);
  }
}

function onCredential(resp) {
  const c = decodeJwt(resp.credential);
  if (!c) return;
  S.token = resp.credential;
  S.claims = c;
  store.set('hb_token', resp.credential);
  if (pendingToken) { pendingToken.resolve(); pendingToken = null; return; }
  load();
}

/** ID tokens last about an hour. Refresh quietly through One Tap before a call if needed. */
function ensureFreshToken() {
  if (S.claims && S.token && S.claims.exp * 1000 > Date.now() + 60000) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToken = null;
      reject(Object.assign(new Error('Your sign-in expired. Sign in again.'), { code: 'AUTH' }));
    }, 10000);
    pendingToken = { resolve: () => { clearTimeout(timer); resolve(); } };
    whenGsi(() => google.accounts.id.prompt());
  });
}

function showSignIn(msg) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  $('#signin-msg').textContent = msg || '';
  whenGsi(() => {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    $('#gsi-btn').innerHTML = '';
    google.accounts.id.renderButton($('#gsi-btn'), {
      theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 280,
    });
    if (!msg) google.accounts.id.prompt();
  });
}

/** keepLocal: an expired sign-in keeps the saved copy so the next sign-in opens instantly. */
function signOut(msg, opts = {}) {
  store.del('hb_token');
  if (!opts.keepLocal) store.del(LOCAL_DATA_KEY);
  S.token = null; S.claims = null; S.data = null; S.fromLocal = false;
  closeAllSheets();
  if (window.google && google.accounts && google.accounts.id && !opts.keepLocal) google.accounts.id.disableAutoSelect();
  showSignIn(msg);
}

/* ================= Boot ================= */
function boot() {
  if (!CONFIG.API_URL || !CONFIG.CLIENT_ID || CONFIG.API_URL.startsWith('PASTE') || CONFIG.CLIENT_ID.startsWith('PASTE')) {
    $('#signin').hidden = false;
    $('#signin-msg').textContent = 'Setup needed: add your API_URL and CLIENT_ID to config.js.';
    return;
  }
  applyTheme();
  const saved = store.get('hb_token');
  const c = saved && decodeJwt(saved);
  if (!c) { showSignIn(); return; }

  const fresh = c.exp * 1000 > Date.now() + 60000;
  const local = loadLocal(c.email);
  if (fresh || local) {
    // With a saved copy, open instantly even if the sign-in needs a quiet refresh first.
    S.token = saved;
    S.claims = c;
    load();
  } else {
    showSignIn();
  }
}

async function load() {
  $('#signin').hidden = true;
  $('#app').hidden = false;
  if (!S.data) {
    const local = S.claims && loadLocal(S.claims.email);
    if (local) {
      setData(local.data, true);
      S.syncedAt = local.savedAt;
      openFromHashOnce();
    } else {
      $('#main').innerHTML = '<p class="empty">Loading your household…</p>';
    }
  }
  await refresh();
}

async function refresh() {
  const hadData = !!S.data;
  try {
    setData(await api('bootstrap', {}, { retry: true }));
    openFromHashOnce();
  } catch (e) {
    if (e.code === 'AUTH' || e.code === 'NOT_INVITED') { handleErr(e); return; }
    if (hadData) {
      toast(`Showing saved data. ${e.message}`, true);
    } else {
      $('#main').innerHTML = `<div class="empty"><strong>Homebase didn't load</strong>${esc(e.message)}<p><button class="btn" data-act="reload">Try again</button></p></div>`;
    }
  }
}

function openFromHashOnce() {
  if (S.hashOpened) return;
  S.hashOpened = true;
  openFromHash();
}
function openFromHash() {
  const m = location.hash.match(/item=([\w-]+)/);
  if (m && itemById(m[1])) openDetail(m[1]);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.data && !document.body.classList.contains('sheet-open') && Date.now() - S.syncedAt > 60000) {
    refresh();
  }
});
window.addEventListener('hashchange', () => S.data && openFromHash());

/* ================= Theme ================= */
function applyTheme() {
  const t = store.get('hb_theme') || 'system';
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#12181A' : '#EDF0EE');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ================= Render ================= */
function render() {
  if (!S.data) return;
  $('#today-label').textContent = fmt(today(), { weekday: 'long', month: 'long', day: 'numeric' });
  const views = { upcoming: renderUpcoming, calendar: renderCalendar, bills: renderBills, more: renderMore };
  $('#main').innerHTML = views[S.tab]();
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  renderSelectBar();
}

function filtersHTML() {
  const types = [['all', 'All'], ['upkeep', 'Upkeep'], ['bill', 'Bills'], ['event', 'Events'], ['task', 'Tasks']];
  return `<div class="filters">
    <div class="seg" role="group" aria-label="Whose items">
      <button data-act="who" data-v="all" aria-pressed="${S.who === 'all'}">Everyone</button>
      <button data-act="who" data-v="mine" aria-pressed="${S.who === 'mine'}">Mine</button>
    </div>
    <div class="chips scroll" role="group" aria-label="Item type">
      ${types.map(([v, l]) => `<button class="chip" data-act="type" data-v="${v}" aria-pressed="${S.typeFilter === v}">${l}</button>`).join('')}
    </div>
  </div>`;
}

function rowHTML(o) {
  const i = o.item;
  const late = o.date < today() && i.type !== 'event';
  const note = o.note != null ? o.note : '';
  const meta = [`<span class="${late ? 'late' : ''}">${rel(o.date)}${o.time ? ', ' + fmtTime(o.time) : ''}</span>`];
  if (i.type === 'bill' && i.amount) meta.push(`<span>${peso(i.amount)}</span>`);
  if (i.type === 'bill' && i.category) meta.push(`<span>${esc(i.category)}</span>`);
  const pick = S.selecting && canComplete(i) && !o.projected ? `<span class="pick${S.picked.has(i.id) ? ' on' : ''}" aria-hidden="true"></span>` : '';
  return `<button class="row t-${i.type}${late ? ' is-late' : ''}${o.projected ? ' ghost' : ''}" data-act="open" data-id="${i.id}"${S.selecting ? ` aria-pressed="${S.picked.has(i.id)}"` : ''}>
    ${pick}
    <span class="stub" aria-hidden="true"><small>${fmt(o.date, { weekday: 'short' })}</small><b>${toD(o.date).getUTCDate()}</b><small>${fmt(o.date, { month: 'short' })}</small></span>
    <span class="body">
      <span class="title">${esc(i.title)}</span>
      ${note ? `<span class="sub">${esc(note)}</span>` : ''}
      <span class="meta">${meta.join('')}</span>
    </span>
    <span class="who">${assignees(i).slice(0, 3).map(avatar).join('')}</span>
  </button>`;
}

/* ----- Upcoming ----- */
function renderUpcoming() {
  const t = today();
  const weekEnd = addDays(t, 6);
  const horizon = addDays(t, EVENT_HORIZON_DAYS);
  const rows = filteredItems().map((i) => ({ item: i, ...view(i) }))
    .filter((o) => o.item.type !== 'event' || S.typeFilter === 'event' || o.date <= horizon)
    .sort(sortOcc);
  const groups = [
    ['Overdue', rows.filter((o) => o.date < t), 'late'],
    ['Next 7 days', rows.filter((o) => o.date >= t && o.date <= weekEnd), ''],
    ['Later', rows.filter((o) => o.date > weekEnd), ''],
  ].filter((g) => g[1].length);

  const selectBtn = isAdmin()
    ? `<button class="btn sm quiet" data-act="select">${S.selecting ? 'Cancel' : 'Select'}</button>` : '';
  const body = groups.length
    ? groups.map(([label, list, cls]) => `<h3 class="group-h ${cls}">${label} <span class="count">${list.length}</span></h3>
        <div class="list">${list.map(rowHTML).join('')}</div>`).join('')
    : `<div class="empty"><strong>${S.who === 'mine' || S.typeFilter !== 'all' ? 'Nothing matches these filters' : 'Nothing scheduled yet'}</strong>
        Tap + to add upkeep, a bill, a family date or a task.</div>`;
  return `<div class="head-row"><h2 class="h">Upcoming</h2>${selectBtn}</div>${filtersHTML()}${body}`;
}

function renderSelectBar() {
  const bar = $('#selectbar');
  if (!S.selecting || S.tab !== 'upcoming') { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span class="n">${S.picked.size} selected</span>
    <button class="btn sm" data-act="select">Cancel</button>
    <button class="btn sm primary" data-act="bulk-done" ${S.picked.size ? '' : 'disabled'}>Mark done</button>`;
}

/* ----- Calendar ----- */
function renderCalendar() {
  const c = S.cal;
  let label, grid;
  if (c.mode === 'month') {
    const start = weekStart(monthStart(c.cursor));
    const end = addDays(start, 41);
    const map = occMap(start, end);
    const t = today();
    label = fmt(c.cursor, { month: 'long', year: 'numeric' });
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
    let cells = '';
    for (let k = 0; k < 42; k++) {
      const d = addDays(start, k);
      const list = map[d] || [];
      const out = d.slice(0, 7) !== c.cursor.slice(0, 7);
      const dots = list.slice(0, 3).map((o) => `<span class="dot t-${o.item.type}${o.date < t && o.item.type !== 'event' ? ' is-late' : ''}"></span>`).join('')
        + (list.length > 3 ? '<span class="more-dot">+</span>' : '');
      cells += `<button class="cal-cell${out ? ' out' : ''}${d === t ? ' today' : ''}${d === c.selected ? ' sel' : ''}" data-act="cal-day" data-d="${d}" aria-label="${fmtLong(d)}, ${list.length} item${list.length === 1 ? '' : 's'}">
        <span class="n">${toD(d).getUTCDate()}</span><span class="dots">${dots}</span></button>`;
    }
    const sel = map[c.selected] || [];
    grid = `<div class="cal-grid">${dows}${cells}</div>
      <h3 class="day-h${c.selected === t ? ' today' : ''}">${fmt(c.selected, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
      ${sel.length ? `<div class="list">${sel.map(rowHTML).join('')}</div>` : '<p class="day-empty">Nothing on this day.</p>'}`;
  } else {
    const start = weekStart(c.cursor);
    const end = addDays(start, 6);
    const map = occMap(start, end);
    const t = today();
    label = `${fmtShort(start)} – ${fmtShort(end)}`;
    grid = '';
    for (let k = 0; k < 7; k++) {
      const d = addDays(start, k);
      const list = map[d] || [];
      grid += `<h3 class="day-h${d === t ? ' today' : ''}">${fmt(d, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
        ${list.length ? `<div class="list">${list.map(rowHTML).join('')}</div>` : '<p class="day-empty">Nothing scheduled.</p>'}`;
    }
  }
  return `<div class="head-row"><h2 class="h">Calendar</h2>
      <div class="seg" role="group" aria-label="Calendar view">
        <button data-act="cal-mode" data-v="month" aria-pressed="${c.mode === 'month'}">Month</button>
        <button data-act="cal-mode" data-v="week" aria-pressed="${c.mode === 'week'}">Week</button>
      </div></div>
    ${filtersHTML()}
    <div class="cal-bar">
      <button class="icon" data-act="cal-prev" aria-label="Previous">${ICON.left}</button>
      <span class="label">${label}</span>
      <button class="btn sm quiet" data-act="cal-today">Today</button>
      <button class="icon" data-act="cal-next" aria-label="Next">${ICON.right}</button>
    </div>
    ${grid}`;
}

/* ----- Bills ----- */
function periodRange() {
  const b = S.bills;
  const [y, m] = b.cursor.split('-').map(Number);
  if (b.period === 'year') return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  if (b.period === 'quarter') {
    const q = Math.floor((m - 1) / 3);
    const start = `${y}-${pad(q * 3 + 1)}-01`;
    return { start, end: monthEnd(`${y}-${pad(q * 3 + 3)}-01`), label: `Q${q + 1} ${y}` };
  }
  return { start: monthStart(b.cursor), end: monthEnd(b.cursor), label: fmt(b.cursor, { month: 'long', year: 'numeric' }) };
}

function billPayments() {
  const cats = S.bills.cats;
  return S.data.completions.filter((c) => c.type === 'bill' && c.kind === 'done' && c.amount !== '' && !isNaN(Number(c.amount)))
    .filter((c) => !cats.length || cats.includes(c.category || 'Uncategorized'));
}

function renderBills() {
  const b = S.bills;
  const r = periodRange();
  const pays = billPayments();
  const inPeriod = pays.filter((c) => c.doneDate >= r.start && c.doneDate <= r.end);
  const total = inPeriod.reduce((s, c) => s + Number(c.amount), 0);

  const byCat = {};
  inPeriod.forEach((c) => { const k = c.category || 'Uncategorized'; byCat[k] = (byCat[k] || 0) + Number(c.amount); });
  const catRows = Object.entries(byCat).sort((a, z) => z[1] - a[1]);
  const maxCat = catRows.length ? catRows[0][1] : 0;

  // 12 months ending with the period's last month
  const months = [];
  let mm = addMonths(monthStart(r.end), -11);
  for (let k = 0; k < 12; k++) { months.push(mm); mm = addMonths(mm, 1); }
  const sums = months.map((m0) => pays.filter((c) => c.doneDate.slice(0, 7) === m0.slice(0, 7)).reduce((s, c) => s + Number(c.amount), 0));
  const maxSum = Math.max(1, ...sums);
  const W = 360, H = 120, gap = 6, bw = (W - gap * 11) / 12;
  const bars = months.map((m0, k) => {
    const h = Math.max(sums[k] ? 3 : 0, (sums[k] / maxSum) * (H - 22));
    const on = m0 >= monthStart(r.start) && m0 <= r.end;
    return `<rect class="bar${on ? ' on' : ''}" x="${(k * (bw + gap)).toFixed(1)}" y="${(H - 16 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${fmt(m0, { month: 'short', year: 'numeric' })}: ${peso(sums[k])}</title></rect>
      <text x="${(k * (bw + gap) + bw / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">${fmt(m0, { month: 'narrow' })}</text>`;
  }).join('');

  const allCats = [...new Set([...S.data.categories, ...pays.map((c) => c.category || 'Uncategorized')])];
  const chips = [`<button class="chip" data-act="bill-cat" data-v="" aria-pressed="${!b.cats.length}">All</button>`]
    .concat(allCats.map((c) => `<button class="chip" data-act="bill-cat" data-v="${esc(c)}" aria-pressed="${b.cats.includes(c)}">${esc(c)}</button>`)).join('');

  const bills = S.data.items.filter((i) => i.type === 'bill' && i.status === 'active')
    .map((i) => ({ item: i, ...view(i) })).sort(sortOcc);

  return `<div class="head-row"><h2 class="h">Bills</h2></div>
    <section class="panel" aria-label="Spending summary">
      <div class="seg full" role="group" aria-label="Period">
        ${['month', 'quarter', 'year'].map((p) => `<button data-act="bill-period" data-v="${p}" aria-pressed="${b.period === p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}
      </div>
      <div class="period-bar">
        <button class="icon" data-act="bill-prev" aria-label="Previous period">${ICON.left}</button>
        <span class="label">${r.label}</span>
        <button class="icon" data-act="bill-next" aria-label="Next period">${ICON.right}</button>
      </div>
      <p class="total">${peso(total)}</p>
      <p class="total-sub">${inPeriod.length} payment${inPeriod.length === 1 ? '' : 's'} logged${b.cats.length ? ' in selected categories' : ''}</p>
      <div class="chips scroll" role="group" aria-label="Categories">${chips}</div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly bill totals for the last 12 months">${bars}</svg>
      ${catRows.length ? `<ul class="breakdown">${catRows.map(([k, v]) => `<li>
          <div class="top-line"><span>${esc(k)}</span><span class="amt">${peso(v)}</span></div>
          <div class="track"><div class="fillbar" style="width:${Math.max(2, (v / maxCat) * 100).toFixed(1)}%"></div></div></li>`).join('')}</ul>`
        : '<p class="day-empty">No payments logged in this period.</p>'}
    </section>
    <h3 class="group-h">Your bills <span class="count">${bills.length}</span></h3>
    ${bills.length ? `<div class="list">${bills.map(rowHTML).join('')}</div>`
      : '<div class="empty"><strong>No bills yet</strong>Tap + and choose Bill to track a due date and what you pay.</div>'}`;
}

/* ----- More ----- */
function syncLine() {
  if (!S.syncedAt) return '';
  let line = `${S.fromLocal ? 'Showing saved data from' : 'Last updated'} ${fmtClock(S.syncedAt)}`;
  const t = S.timing;
  if (t && t.server) {
    line += `. Last request: ${(t.totalMs / 1000).toFixed(1)}s total, ${(t.server.total / 1000).toFixed(1)}s on the server, cache ${t.server.cache}`;
  }
  return `<small>${esc(line)}.</small>`;
}

function renderMore() {
  const theme = store.get('hb_theme') || 'system';
  const admin = isAdmin();
  const users = S.data.users.slice().sort((a, b) => (a.status === 'removed') - (b.status === 'removed') || displayName(a.email).localeCompare(displayName(b.email)));
  const members = users.map((u) => {
    const mine = u.email === me();
    const status = u.status === 'invited' ? '<span class="badge">Invited</span>' : u.status === 'removed' ? '<span class="badge">Removed</span>' : '';
    const controls = !admin ? `<small>${u.role === 'admin' ? 'Admin' : 'Member'}</small>`
      : u.status === 'removed'
        ? `<button class="btn sm" data-act="user-reinvite" data-email="${esc(u.email)}" data-busy>Invite again</button>`
        : `<select data-act="user-role" data-email="${esc(u.email)}" aria-label="Role for ${esc(displayName(u.email))}">
             <option value="member"${u.role !== 'admin' ? ' selected' : ''}>Member</option>
             <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select>
           ${u.status === 'invited' ? `<button class="btn sm quiet" data-act="user-reinvite" data-email="${esc(u.email)}" data-busy>Resend</button>` : ''}
           ${mine ? '' : `<button class="btn sm quiet danger" data-act="user-remove" data-email="${esc(u.email)}" data-busy>Remove</button>`}`;
    return `<div class="member">${avatar(u.email)}<div class="who-info">${esc(displayName(u.email))}${mine ? ' (you)' : ''}${status}<small>${esc(u.email)}</small></div>${controls}</div>`;
  }).join('');

  const invite = admin ? `<form id="invite-form" class="form" style="margin-top:14px" novalidate>
      <div class="two-col">
        <label class="field"><span>Name</span><input name="name" autocomplete="off" placeholder="Mama"></label>
        <label class="field"><span>Role</span><select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
      </div>
      <label class="field"><span>Google account email</span><input name="email" type="email" inputmode="email" autocomplete="off" required placeholder="name@gmail.com"></label>
      <button class="btn primary" type="submit">Send invite</button>
    </form>` : '';

  const archived = S.data.items.filter((i) => i.status === 'archived' || i.status === 'done')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const archiveList = archived.length ? archived.map((i) => `<div class="member t-${i.type}">
      <div class="who-info">${esc(i.title)}<small>${i.status === 'done' ? 'Finished' : 'Archived'} ${i.updatedAt ? fmtShort(i.updatedAt.slice(0, 10)) : ''}</small></div>
      <button class="btn sm" data-act="restore" data-id="${i.id}" data-busy>${i.status === 'done' ? 'Reopen' : 'Restore'}</button>
      ${admin ? `<button class="btn sm quiet danger" data-act="purge" data-id="${i.id}" data-busy>Delete</button>` : ''}
    </div>`).join('') : '<p class="day-empty">Archived and finished one-off items appear here.</p>';

  const cats = S.data.categories.map((c) => `<button class="chip" data-act="cat-del" data-v="${esc(c)}" aria-label="Remove ${esc(c)}">${esc(c)}<span class="x">${ICON.x}</span></button>`).join('');

  return `<div class="head-row"><h2 class="h">More</h2></div>
    <section class="panel help" aria-label="How Homebase works">
      <h2>How Homebase works</h2>
      ${HELP_HTML}
    </section>
    <section class="panel">
      <h2>Family members</h2>
      ${members}
      ${invite}
    </section>
    <section class="panel">
      <h2>Bill categories</h2>
      <div class="chips">${cats}</div>
      <form id="cat-form" class="inline" style="margin-top:12px" novalidate>
        <input name="cat" placeholder="New category" autocomplete="off" aria-label="New category">
        <button class="btn" type="submit">Add</button>
      </form>
    </section>
    <section class="panel">
      <h2>Appearance</h2>
      <div class="seg full" role="group" aria-label="Theme">
        ${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button data-act="theme" data-v="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}
      </div>
    </section>
    <section class="panel">
      <h2>Archive</h2>
      ${archiveList}
    </section>
    <section class="panel">
      <h2>Account</h2>
      <div class="member">${avatar(me())}<div class="who-info">${esc(S.data.me.name)}<small>${esc(me())}</small></div>
        <button class="btn sm" data-act="signout">Sign out</button></div>
      <div class="member"><div class="who-info">Sync${syncLine()}</div>
        <button class="btn sm" data-act="reload" data-busy>Refresh</button></div>
    </section>`;
}

const HELP_HTML = `
<details><summary>The four kinds of items</summary><div class="answer">
  <p><b>Upkeep</b> is recurring home maintenance done by a vendor, like aircon cleaning or the grease trap.</p>
  <p><b>Bills</b> have a due date and an amount. When you mark one paid, you log what was paid and who paid it.</p>
  <p><b>Events</b> are birthdays, anniversaries and other yearly dates. They don't need ticking off. They appear in Upcoming when they're ${EVENT_HORIZON_DAYS} days away, and always on the Calendar.</p>
  <p><b>Tasks</b> are anything else with a date, one-off or repeating.</p>
</div></details>
<details><summary>Two ways to repeat</summary><div class="answer">
  <p><b>On a schedule</b> keeps the same rhythm: every month on the 15th, every quarter, every week. Paying late doesn't move the next due date. Use this for bills.</p>
  <p><b>After completion</b> counts from the day it's actually done. If the aircon is cleaned 10 days late, the next cleaning moves 10 days later too. Use this for upkeep.</p>
</div></details>
<details><summary>Upkeep that needs a vendor booking</summary><div class="answer">
  <p>Choose <b>Book a vendor first</b> when adding upkeep. Homebase reminds you to book a set number of days before the service is due.</p>
  <ol><li>When you've booked, tap <b>Mark booked</b> and enter the appointment date.</li>
  <li>After the job, tap <b>Mark done</b>. The date you enter sets when the next one is due.</li></ol>
</div></details>
<details><summary>Who can tick things off</summary><div class="answer">
  <p>Anyone assigned to an item can mark it done. If nobody is assigned, anyone can. The admin can tick off any item, and can use <b>Select</b> in Upcoming to mark several done at once.</p>
  <p>Marked something by mistake? Open the item and remove the record from its history. The next due date stays where it moved to, so adjust it with <b>Edit</b> if needed.</p>
</div></details>
<details><summary>Archiving and deleting</summary><div class="answer">
  <p>Archiving hides an item without losing its history. Restore it anytime from the Archive below. Only the admin can delete permanently.</p>
</div></details>
<details><summary>Why the list sometimes updates a moment after opening</summary><div class="answer">
  <p>Homebase shows the copy saved on this phone right away, then checks for changes from the rest of the family. The thin bar at the top means it's checking. Signing out removes the saved copy from this phone.</p>
</div></details>
<details><summary>Google Calendar</summary><div class="answer">
  <p class="soon">Calendar sync arrives in the next update.</p>
  <p>Each item will appear on the shared family calendar as one event with a link back here. To add something from Google Calendar, put <b>#home</b> in the event title.</p>
  <p>Calendar reminders are personal, so each person turns them on once: on calendar.google.com, open the shared calendar's <b>Settings and sharing</b>, then add notifications under <b>Event notifications</b> and <b>All-day event notifications</b>.</p>
</div></details>
<details><summary>Phone alerts</summary><div class="answer">
  <p class="soon">Push alerts arrive in a later update.</p>
  <p>On iPhone they only work when Homebase is added to the Home Screen: in Safari, tap Share, then <b>Add to Home Screen</b>, then open Homebase from its icon. You can do this now.</p>
</div></details>`;

/* ================= Sheets (full-screen on phones) ================= */
const sheets = [];

function openSheet(html, opts = {}) {
  const el = document.createElement('div');
  el.className = 'sheet' + (opts.small ? ' small' : '');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="sheet-panel">${html}</div>`;
  $('#sheets').appendChild(el);
  sheets.push(el);
  document.body.classList.add('sheet-open');
  el.addEventListener('click', (ev) => { if (ev.target === el) closeSheet(); });
  requestAnimationFrame(() => el.classList.add('in'));
  if (opts.onMount) opts.onMount(el);
  setBusy(0); // apply the current busy state to the new sheet's buttons
  return el;
}

function closeSheet() {
  const el = sheets.pop();
  if (!el) return;
  el.classList.remove('in');
  setTimeout(() => el.remove(), 200);
  if (!sheets.length) {
    document.body.classList.remove('sheet-open');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }
}
function closeAllSheets() { while (sheets.length) closeSheet(); }

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheets.length) closeSheet(); });

function sheetHead(title, right = '') {
  return `<header class="sheet-head"><button class="icon" data-act="close" aria-label="Close">${ICON.x}</button><h2>${esc(title)}</h2>${right}</header>`;
}

/* ----- Detail ----- */
function openDetail(id) {
  const i = itemById(id);
  if (!i) { toast('That item no longer exists.', true); return; }
  const v = i.status === 'active' ? view(i) : null;
  const facts = [];

  if (i.type === 'event') {
    const d = view(i).date;
    facts.push(['Next', `${fmtLong(d)}${eventNote(i, d) ? ', ' + eventNote(i, d).toLowerCase() : ''}`]);
    facts.push(['Original date', fmtLong(i.eventDate)]);
  } else if (v && v.stage === 'to_book') {
    facts.push(['Book by', `${fmtLong(v.date)} (${rel(v.date).toLowerCase()})`]);
    facts.push(['Service due', fmtLong(i.dueDate)]);
  } else if (v && v.stage === 'booked') {
    facts.push(['Appointment', `${fmtLong(i.apptDate)}${i.apptTime ? ', ' + fmtTime(i.apptTime) : ''}`]);
    facts.push(['Service due', fmtLong(i.dueDate)]);
  } else if (i.dueDate) {
    facts.push([i.status === 'active' ? 'Due' : 'Last due', `${fmtLong(i.dueDate)}${i.dueTime ? ', ' + fmtTime(i.dueTime) : ''}`]);
  }
  facts.push(['Repeats', describeRecur(i)]);
  facts.push(['Assigned to', assignees(i).length ? assignees(i).map(displayName).map(esc).join(', ') : 'Anyone']);
  if (i.type === 'bill') {
    if (i.category) facts.push(['Category', esc(i.category)]);
    if (i.amount) facts.push(['Usual amount', peso(i.amount)]);
  }
  if (i.type === 'upkeep' && (i.vendorName || i.vendorPhone)) {
    const tel = i.vendorPhone ? `<a href="tel:${esc(i.vendorPhone.replace(/[^\d+]/g, ''))}">${esc(i.vendorPhone)}</a>` : '';
    facts.push(['Vendor', [esc(i.vendorName), tel].filter(Boolean).join('<br>')]);
  }
  if (i.status !== 'active') facts.push(['Status', i.status === 'done' ? 'Finished' : 'Archived']);

  const can = canComplete(i);
  const acts = [];
  if (can) {
    if (v.stage === 'to_book') {
      acts.push('<button class="btn primary" data-act="book" data-busy>Mark booked</button>');
      acts.push('<button class="btn" data-act="done" data-busy>Mark done</button>');
    } else if (v.stage === 'booked') {
      acts.push('<button class="btn primary" data-act="done" data-busy>Mark done</button>');
      acts.push('<button class="btn" data-act="book" data-busy>Change booking</button>');
      acts.push('<button class="btn quiet" data-act="unbook" data-busy>Clear booking</button>');
    } else {
      acts.push(`<button class="btn primary" data-act="done" data-busy>${i.type === 'bill' ? 'Mark paid' : 'Mark done'}</button>`);
    }
    if (i.recurMode !== 'none') acts.push('<button class="btn quiet" data-act="skip" data-busy>Skip this one</button>');
  }

  const hist = S.data.completions.filter((c) => c.itemId === id)
    .sort((a, b) => b.doneDate.localeCompare(a.doneDate) || b.at.localeCompare(a.at));
  const paid = hist.filter((c) => c.kind === 'done' && c.amount !== '').slice(0, 12).reverse();
  let spark = '';
  if (i.type === 'bill' && paid.length >= 2) {
    const vals = paid.map((c) => Number(c.amount));
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((val, k) => [8 + (k * 304) / (vals.length - 1), 48 - ((val - lo) / span) * 40]);
    spark = `<svg class="spark" viewBox="0 0 320 56" role="img" aria-label="Amounts paid over time, from ${peso(lo)} to ${peso(hi)}">
      <polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/>
      ${pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5"/>`).join('')}</svg>`;
  }
  const histHTML = hist.length ? `<h3 class="section-h">History</h3>${spark}<ul class="hist">${hist.map((c) => {
    const what = c.kind === 'skipped' ? 'Skipped'
      : c.amount !== '' ? `Paid ${peso(c.amount)}${c.paidBy ? ' by ' + esc(displayName(c.paidBy)) : ''}` : 'Done';
    const canDel = isAdmin() || c.by === me();
    return `<li><span class="what">${what}<small>${fmtLong(c.doneDate)}, logged by ${esc(displayName(c.by))}${c.note ? '. ' + esc(c.note) : ''}</small></span>
      ${canDel ? `<button class="icon" data-act="del-comp" data-cid="${c.id}" aria-label="Remove this record" data-busy>${ICON.x}</button>` : ''}</li>`;
  }).join('')}</ul>` : '';

  const manage = i.status === 'active'
    ? `<div class="actions" style="margin-top:18px"><button class="btn" data-act="edit">Edit</button><button class="btn quiet danger" data-act="archive" data-busy>Archive</button></div>`
    : `<div class="actions" style="margin-top:18px"><button class="btn" data-act="restore" data-id="${i.id}" data-busy>${i.status === 'done' ? 'Reopen' : 'Restore'}</button></div>`;

  openSheet(`${sheetHead(TYPES[i.type].label)}
    <div class="sheet-body t-${i.type}" data-item="${i.id}">
      <div class="detail-title"><div><h3>${esc(i.title)}</h3>${v && v.note ? `<span class="kind">${esc(v.note)}</span>` : ''}</div></div>
      <dl class="facts">${facts.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('')}</dl>
      ${i.notes ? `<p class="notes">${esc(i.notes)}</p>` : ''}
      ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
      ${histHTML}
      ${manage}
    </div>`);
}

/* ----- Mark done / paid ----- */
function openComplete(i) {
  const isBill = i.type === 'bill';
  const users = activeUsers();
  const afterNote = i.recurMode === 'after' ? `<p class="hint">The next one will be due ${i.afterDays} days after this date.</p>` : '';
  const html = `${sheetHead(isBill ? 'Mark paid' : 'Mark done')}
    <form id="complete-form" class="sheet-body form" data-id="${i.id}" novalidate>
      <p style="margin:0;font-weight:600">${esc(i.title)}</p>
      ${isBill ? `<label class="field"><span>Amount paid (₱)</span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(i.amount || '')}"></label>
        <label class="field"><span>Paid by</span><select name="paidBy">${users.map((u) => `<option value="${esc(u.email)}"${u.email === me() ? ' selected' : ''}>${esc(displayName(u.email))}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>${isBill ? 'Date paid' : 'Date done'}</span><input name="doneDate" type="date" required value="${today()}">${afterNote}</label>
      <label class="field"><span>Note (optional)</span><input name="note" autocomplete="off"></label>
      <button class="btn primary" type="submit">${isBill ? 'Mark paid' : 'Mark done'}</button>
    </form>`;
  openSheet(html, { small: true });
}

/* ----- Book ----- */
function openBook(i) {
  const html = `${sheetHead('Mark booked')}
    <form id="book-form" class="sheet-body form" data-id="${i.id}" novalidate>
      <p style="margin:0;font-weight:600">${esc(i.title)}</p>
      <div class="two-col">
        <label class="field"><span>Appointment date</span><input name="apptDate" type="date" required value="${esc(i.apptDate || i.dueDate)}"></label>
        <label class="field"><span>Time (optional)</span><input name="apptTime" type="time" value="${esc(i.apptTime || '')}"></label>
      </div>
      <button class="btn primary" type="submit">Mark booked</button>
    </form>`;
  openSheet(html, { small: true });
}

/* ----- Add / edit ----- */
function openTypePicker() {
  const tiles = Object.entries(TYPES).map(([k, t]) => `<button class="type-tile t-${k}" data-act="add-type" data-v="${k}"><b>${t.label}</b><span>${t.hint}</span></button>`).join('');
  openSheet(`${sheetHead('Add')}<div class="sheet-body"><div class="type-grid">${tiles}</div></div>`, { small: true });
}

function openForm(type, it) {
  const e = it || {};
  type = it ? it.type : type;
  const assigned = new Set(it ? assignees(it) : [me()]);
  const recur = e.recurMode && e.recurMode !== 'yearly' ? e.recurMode : (type === 'bill' ? 'fixed' : type === 'upkeep' ? 'after' : 'none');
  const flow = e.flow || 'two';
  const placeholders = { upkeep: 'Aircon cleaning', bill: 'Meralco', event: "Mama's birthday", task: 'Renew car registration' };

  const dueLabel = type === 'upkeep' ? 'Service due' : 'Due date';
  const dueFields = type === 'event' ? '' : `<div class="two-col">
      <label class="field"><span>${dueLabel}</span><input name="dueDate" type="date" required value="${esc(e.dueDate || today())}"></label>
      ${type === 'task' ? `<label class="field"><span>Time (optional)</span><input name="dueTime" type="time" value="${esc(e.dueTime || '')}"></label>` : '<span></span>'}
    </div>`;

  const eventFields = type !== 'event' ? '' : `
    <label class="field"><span>Kind</span><select name="eventKind">
      ${[['birthday', 'Birthday'], ['anniversary', 'Anniversary'], ['other', 'Other yearly date']].map(([v, l]) => `<option value="${v}"${(e.eventKind || 'birthday') === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label class="field"><span>Date</span><input name="eventDate" type="date" required value="${esc(e.eventDate || '')}"><span class="hint">Use the original date, such as the birth year or wedding year.</span></label>
    <label class="check"><input type="checkbox" name="showYears" value="yes"${e.showYears !== 'no' ? ' checked' : ''}> Show age or years</label>`;

  const billFields = type !== 'bill' ? '' : `<div class="two-col">
      <label class="field"><span>Usual amount (₱)</span><input name="amount" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(e.amount || '')}"></label>
      <label class="field"><span>Category</span><select name="category">
        ${S.data.categories.map((c) => `<option${e.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        ${e.category && !S.data.categories.includes(e.category) ? `<option selected>${esc(e.category)}</option>` : ''}
      </select></label>
    </div>`;

  const flowFields = type !== 'upkeep' ? '' : `
    <fieldset class="field"><legend>How it works</legend>
      <div class="seg full">
        <label><input type="radio" name="flow" value="two"${flow === 'two' ? ' checked' : ''}>Book a vendor first</label>
        <label><input type="radio" name="flow" value="one"${flow === 'one' ? ' checked' : ''}>Just a reminder</label>
      </div>
    </fieldset>
    <label class="field" data-show="flow:two"><span>Remind me to book</span>
      <span class="inline"><input name="leadDays" type="number" inputmode="numeric" min="0" value="${esc(e.leadDays || '14')}"> days before it's due</span></label>`;

  const recurFields = type === 'event' ? '' : `
    <fieldset class="field"><legend>Repeats</legend>
      <div class="seg full">
        <label><input type="radio" name="recurMode" value="none"${recur === 'none' ? ' checked' : ''}>No</label>
        <label><input type="radio" name="recurMode" value="fixed"${recur === 'fixed' ? ' checked' : ''}>On a schedule</label>
        <label><input type="radio" name="recurMode" value="after"${recur === 'after' ? ' checked' : ''}>After done</label>
      </div>
    </fieldset>
    <div class="field" data-show="recurMode:fixed">
      <span class="inline">Every <input name="interval" type="number" inputmode="numeric" min="1" value="${esc(e.interval || '1')}" aria-label="Interval">
        <select name="freq" aria-label="Unit">${Object.entries(FREQ).map(([k, u]) => `<option value="${k}"${(e.freq || 'monthly') === k ? ' selected' : ''}>${u[1]}</option>`).join('')}</select></span>
      <span class="hint">Keeps the same day each time, even if it's done late.</span>
    </div>
    <div class="field" data-show="recurMode:after">
      <span class="inline"><input name="afterDays" type="number" inputmode="numeric" min="1" value="${esc(e.afterDays || '90')}" aria-label="Days"> days after it's done</span>
      <span class="hint">The next date counts from the day you mark it done.</span>
    </div>`;

  const vendorFields = type !== 'upkeep' ? '' : `<div class="two-col">
      <label class="field"><span>Vendor (optional)</span><input name="vendorName" autocomplete="off" value="${esc(e.vendorName || '')}"></label>
      <label class="field"><span>Vendor phone</span><input name="vendorPhone" type="tel" inputmode="tel" autocomplete="off" value="${esc(e.vendorPhone || '')}"></label>
    </div>`;

  const people = activeUsers().map((u) => `<label class="chip"><input type="checkbox" name="assignees" value="${esc(u.email)}"${assigned.has(u.email) ? ' checked' : ''}><span>${esc(displayName(u.email))}</span></label>`).join('');

  const html = `${sheetHead(`${it ? 'Edit' : 'New'} ${TYPES[type].label.toLowerCase()}`, '<button class="btn sm primary" type="submit" form="item-form">Save</button>')}
    <form id="item-form" class="sheet-body form t-${type}" data-type="${type}" data-id="${esc(e.id || '')}" novalidate>
      <label class="field"><span>Title</span><input name="title" required autocomplete="off" value="${esc(e.title || '')}" placeholder="${esc(placeholders[type])}"></label>
      ${eventFields}${flowFields}${dueFields}${billFields}${recurFields}
      <fieldset class="field"><legend>${type === 'event' ? 'Who gets reminded' : 'Assigned to'}</legend><div class="chips">${people}</div>
        <span class="hint">${type === 'event' ? 'Optional.' : 'Leave empty to let anyone tick it off.'}</span></fieldset>
      ${vendorFields}
      <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(e.notes || '')}</textarea></label>
      <button class="btn primary" type="submit">Save</button>
    </form>`;
  openSheet(html, { onMount: (el) => { const f = $('#item-form', el); syncForm(f); f.addEventListener('change', () => syncForm(f)); } });
}

function syncForm(form) {
  form.querySelectorAll('[data-show]').forEach((el) => {
    const [name, vals] = el.dataset.show.split(':');
    const ctl = form.elements[name];
    el.hidden = !ctl || !vals.split('|').includes(ctl.value);
  });
}

/* ================= Event handling ================= */
document.addEventListener('click', async (ev) => {
  const a = ev.target.closest('[data-act]');
  if (!a || a.tagName === 'SELECT') return;
  const act = a.dataset.act;
  const v = a.dataset.v;
  const sheetItemId = a.closest('[data-item]') && a.closest('[data-item]').dataset.item;

  switch (act) {
    case 'close': closeSheet(); break;
    case 'reload': if (S.data) refresh(); else load(); break;
    case 'tab':
      S.tab = a.dataset.tab;
      if (S.tab !== 'upcoming') { S.selecting = false; S.picked.clear(); }
      render(); window.scrollTo(0, 0); break;
    case 'who': S.who = v; store.set('hb_who', v); render(); break;
    case 'type': S.typeFilter = v; render(); break;
    case 'open': {
      const id = a.dataset.id;
      const i = itemById(id);
      if (S.selecting && S.tab === 'upcoming' && i && canComplete(i)) {
        if (S.picked.has(id)) S.picked.delete(id); else S.picked.add(id);
        render();
      } else {
        openDetail(id);
      }
      break;
    }
    case 'select': S.selecting = !S.selecting; S.picked.clear(); render(); break;
    case 'bulk-done': {
      const n = S.picked.size;
      if (!n || !confirm(`Mark ${n} item${n === 1 ? '' : 's'} done for today? Bills are logged at their usual amount.`)) break;
      if (await mutate('bulkComplete', { ids: [...S.picked] }, `Marked ${n} done`)) { S.selecting = false; S.picked.clear(); render(); }
      break;
    }

    case 'cal-mode': S.cal.mode = v; render(); break;
    case 'cal-prev':
    case 'cal-next': {
      const dir = act === 'cal-next' ? 1 : -1;
      if (S.cal.mode === 'month') { S.cal.cursor = addMonths(S.cal.cursor, dir); S.cal.selected = S.cal.cursor; }
      else { S.cal.cursor = addDays(S.cal.cursor, 7 * dir); }
      render(); break;
    }
    case 'cal-today': S.cal.cursor = today(); S.cal.selected = today(); render(); break;
    case 'cal-day':
      S.cal.selected = a.dataset.d;
      if (a.dataset.d.slice(0, 7) !== S.cal.cursor.slice(0, 7)) S.cal.cursor = a.dataset.d;
      render(); break;

    case 'bill-period': S.bills.period = v; render(); break;
    case 'bill-prev':
    case 'bill-next': {
      const step = { month: 1, quarter: 3, year: 12 }[S.bills.period];
      S.bills.cursor = addMonths(S.bills.cursor, act === 'bill-next' ? step : -step);
      render(); break;
    }
    case 'bill-cat':
      if (!v) S.bills.cats = [];
      else S.bills.cats = S.bills.cats.includes(v) ? S.bills.cats.filter((c) => c !== v) : [...S.bills.cats, v];
      render(); break;

    case 'add': openTypePicker(); break;
    case 'add-type': closeSheet(); openForm(v); break;
    case 'edit': openForm(null, itemById(sheetItemId)); break;
    case 'done': openComplete(itemById(sheetItemId)); break;
    case 'book': openBook(itemById(sheetItemId)); break;
    case 'unbook':
      if (await mutate('unbook', { id: sheetItemId }, 'Booking cleared')) { closeAllSheets(); }
      break;
    case 'skip':
      if (!confirm('Skip this one? It moves to the next due date without logging it as done.')) break;
      if (await mutate('skip', { id: sheetItemId }, 'Skipped')) closeAllSheets();
      break;
    case 'archive':
      if (await mutate('archiveItem', { id: sheetItemId }, 'Archived')) closeAllSheets();
      break;
    case 'restore':
      if (await mutate('restoreItem', { id: a.dataset.id }, 'Restored')) closeAllSheets();
      break;
    case 'purge':
      if (!confirm('Delete this item permanently? Its history stays in the spreadsheet, but the item is gone.')) break;
      await mutate('deleteItem', { id: a.dataset.id }, 'Deleted');
      break;
    case 'del-comp':
      if (!confirm('Remove this record? The next due date will not change.')) break;
      if (await mutate('deleteCompletion', { id: a.dataset.cid }, 'Record removed')) { closeAllSheets(); if (sheetItemId) openDetail(sheetItemId); }
      break;

    case 'theme': store.set('hb_theme', v); applyTheme(); render(); break;
    case 'signout': signOut(); break;
    case 'cat-del':
      if (!confirm(`Remove the "${v}" category? Past payments keep it.`)) break;
      await mutate('saveCategories', { categories: S.data.categories.filter((c) => c !== v) }, 'Category removed');
      break;
    case 'user-reinvite':
      await mutate('inviteUser', {
        email: a.dataset.email, resend: true,
        role: (S.data.users.find((u) => u.email === a.dataset.email) || {}).role,
      }, 'Invite sent');
      break;
    case 'user-remove':
      if (!confirm(`Remove ${displayName(a.dataset.email)}? They won't be able to sign in.`)) break;
      await mutate('removeUser', { email: a.dataset.email }, 'Member removed');
      break;
    default: break;
  }
});

document.addEventListener('change', async (ev) => {
  const s = ev.target.closest('select[data-act="user-role"]');
  if (!s) return;
  if (!(await mutate('updateUser', { email: s.dataset.email, role: s.value }, 'Role updated'))) render();
});

document.addEventListener('submit', async (ev) => {
  const f = ev.target;
  ev.preventDefault();
  const fd = new FormData(f);

  if (f.id === 'item-form') {
    const type = f.dataset.type;
    const item = { type };
    for (const [k, val] of fd.entries()) if (k !== 'assignees') item[k] = String(val).trim();
    item.assignees = fd.getAll('assignees').join(',');
    if (f.dataset.id) item.id = f.dataset.id;
    if (type === 'event') item.showYears = fd.get('showYears') ? 'yes' : 'no';
    if (!item.title) { toast('Give it a title.', true); f.elements.title.focus(); return; }
    if (type === 'event' ? !item.eventDate : !item.dueDate) { toast('Pick a date.', true); return; }
    if (item.recurMode === 'after' && !(Number(item.afterDays) >= 1)) { toast('Enter how many days after it is done.', true); return; }
    if (await mutate('saveItem', { item }, item.id ? 'Changes saved' : `${TYPES[type].label} added`)) closeAllSheets();
  }

  if (f.id === 'complete-form') {
    const i = itemById(f.dataset.id);
    const payload = { id: f.dataset.id, doneDate: fd.get('doneDate'), note: fd.get('note') || '' };
    if (i.type === 'bill') { payload.amount = fd.get('amount'); payload.paidBy = fd.get('paidBy'); }
    if (await mutate('complete', payload, i.type === 'bill' ? 'Marked paid' : 'Marked done')) closeAllSheets();
  }

  if (f.id === 'book-form') {
    if (!fd.get('apptDate')) { toast('Pick the appointment date.', true); return; }
    if (await mutate('book', { id: f.dataset.id, apptDate: fd.get('apptDate'), apptTime: fd.get('apptTime') }, 'Marked booked')) closeAllSheets();
  }

  if (f.id === 'invite-form') {
    const email = String(fd.get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter a valid email address.', true); return; }
    if (await mutate('inviteUser', { email, name: fd.get('name'), role: fd.get('role') }, 'Invite sent')) f.reset();
  }

  if (f.id === 'cat-form') {
    const cat = String(fd.get('cat') || '').trim();
    if (!cat) return;
    await mutate('saveCategories', { categories: [...S.data.categories, cat] }, 'Category added');
  }
});

boot();
