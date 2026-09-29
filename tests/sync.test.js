// Multiplayer sync harness: runs the REAL sync, save and trip-load code from index.html in isolated vm
// contexts (one per collaborator or browser tab) against an in-memory Firestore with optimistic
// transactions (SDK-like retry backoff, contention reported as 'failed-precondition'), per-client snapshot
// latency, optional snapshot coalescing and network, and a per-browser localStorage and Web Locks table
// that survive "reloads" (a discarded context followed by a fresh one on the same storage). No network, no
// production data.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

// ---------- extract code ----------
const syncStart = html.indexOf('    // ==================== MULTIPLAYER SYNC ====================');
const syncEnd = html.indexOf('    // ==================== END MULTIPLAYER SYNC ====================');
assert(syncStart > 0 && syncEnd > syncStart, 'sync block not found');
const syncSrc = html.slice(syncStart, syncEnd);
function extractFn(name) {
  const re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(html); assert(m, 'fn ' + name);
  let i = html.indexOf('{', m.index), depth = 0, str = null;
  for (let j = i; j < html.length; j++) {
    const c = html[j], p = html[j - 1];
    if (str) { if (c === str && p !== '\\') str = null; continue; }
    if (c === '/' && html[j + 1] === '/') { j = html.indexOf('\n', j); continue; } // line comment
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function extractLine(re) { const m = re.exec(html); assert(m, 'line ' + re); return m[0]; }
// The trip cache and the load path (cache-first open, first server snapshot, leaving the trip) run for real too.
const loadFns = ['lsKeyForTrip', 'lsLoadTripData', '_lsUid', '_lsCopyKey', '_lsCopyKeys', '_lsRecord', '_lsBaseOf',
  'lsSaveTripData', 'lsRemoveTripData', '_holdCopyLock', '_dropCopyLock', '_liveCopyKeys', '_lsTripCache',
  '_lsRebaseTripCache', 'loadTripData', 'listenForRemoteChanges', '_applyFirstServerSnapshot', 'openTrip',
  '_detachTrip', '_exitTrip', 'goToDashboard', '_leaveSignedOut', 'reconcileDays', '_reconcileOtherDays', 'scheduleSave', 'doSave', '_listenTripMeta',
  '_flushPendingSave', '_retrySaveNow', 'deleteWishItem', 'doSignOut', '_findEv', '_dropEv'];
// So do the paths that link places to calendar events, and the background coordinate lookups.
const placeFns = ['getDay', 'genId', 'toMin', 'minToStr', '_schedulePlace', '_schedStart', 'saveSchedule', 'saveCalAdd', 'removeFromCalendar',
  'extractMapsUrl', '_onCoordsResolved', '_setWishCoords', '_liveWish', 'geocodeWishItem', '_resolveWishCoords', 'backfillEventCoords',
  '_calAddOffered', 'renderCalAddWishList', 'selectCalAddWish', '_calAddNote', '_refreshCalAddList'];
let appSrc = [syncSrc, extractLine(/^ *var _tabId = .*$/m), ...loadFns.map(extractFn),
  extractLine(/^ *var _multiAssignCat=.*$/m), extractLine(/^ *var CAL_ADD_DURS=.*$/m), ...placeFns.map(extractFn),
  // one-liners with quotes inside regex literals, which extractFn would misread as strings
  ...['escH', 'escA', '_sid'].map(n => extractLine(new RegExp('^ *function ' + n + '\\(.*$', 'm')))].join('\n');
if (process.env.DEBUG_REGRESS) {
  const anchor = '        // Bring in whatever the merge picked up from collaborators, on top of edits made while saving.';
  if (!appSrc.includes(anchor)) { /* hook point removed */ }
  appSrc = appSrc.replace(anchor, anchor + "\n        if (typeof __dbg === 'function') __dbg('post', sent, { days: DAYS, wishlist: WISHLIST }, merged, live);");
}

// ---------- fake Firestore + browser ----------
const clone = o => JSON.parse(JSON.stringify(o));
const quietConsole = { log() {}, warn() {}, error() {} };
function makeServer(initial, meta) {
  const srv = { data: clone(initial), meta: clone(meta || { startDate: '2026-10-01', type: 'trip' }), version: 1, listeners: [], commits: 0, conflicts: 0, inDelivery: 0 };
  srv.notify = function () {
    const snapData = clone(srv.data);
    srv.listeners.forEach(l => l.deliver(snapData));
  };
  // What an older copy of the app (or a script) does: DATA_REF.set({days, wishlist}), no transaction, no rev.
  srv.blindSet = function (d) { srv.data = clone(d); srv.version++; srv.notify(); };
  // The trip's details doc: what saving the trip form writes. Listeners (the app's _listenTripMeta) get the
  // server-confirmed copy a little later, like the SDK's snapshot without pending writes.
  srv.metaListeners = [];
  srv.setMeta = function (m) {
    srv.meta = clone(m);
    srv.metaListeners.forEach(l => setTimeout(() => {
      if (l.active && !l.ctx.dead) l.onNext({ exists: true, data: () => clone(srv.meta), metadata: { fromCache: false, hasPendingWrites: false } });
    }, 5 + Math.random() * 20));
  };
  srv.sizeLimit = 0;   // > 0: a write whose JSON is longer fails with invalid-argument, like a doc over 1 MiB
  srv.storm = 0;       // > 0: that many transaction attempts in a row find the doc changed under them
  srv.exhausted = 0;   // transactions that gave up on contention
  return srv;
}
// Web Locks: one table per browser (keyed by its storage). A page's locks go when it's discarded.
const lockTables = new WeakMap();
function makeLocks(storage, owned) {
  let table = lockTables.get(storage);
  if (!table) lockTables.set(storage, (table = new Map()));
  return {
    request(name, cb) {
      const tok = { name, released: false, release() { if (tok.released) return; tok.released = true; const n = table.get(name) - 1; if (n > 0) table.set(name, n); else table.delete(name); } };
      table.set(name, (table.get(name) || 0) + 1); owned.push(tok);
      return Promise.resolve().then(() => cb({ name })).then(v => { tok.release(); return v; }, e => { tok.release(); throw e; });
    },
    query() { return Promise.resolve({ held: Array.from(table.keys()).map(name => ({ name })), pending: [] }); },
  };
}
// localStorage over a Map the test keeps, so a later "page" (client) on the same browser sees what this one left.
function makeStorage(map) {
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    key: i => { const ks = Array.from(map.keys()); return i < ks.length ? ks[i] : null; },
    get length() { return map.size; },
  };
}
// opts.boot: 'synced' (default) starts on the trip already loaded from the server with a live listener;
// 'none' starts on no trip, and the scenario opens it through the real openTrip (c.open()).
// opts.coalesce: like the SDK, a listener that is behind only ever sees the newest state.
// opts.ackDelay: ms a transaction's promise resolves after its write (the watch stream beats the commit reply).
// opts.slowOffline: offline transactions fail only after the SDK's full retry backoff, like 'unavailable' does.
function makeClient(name, srv, opts = {}) {
  const lat = opts.latency || [5, 40];
  const rnd = () => lat[0] + Math.random() * (lat[1] - lat[0]);
  const timers = new Set(), locks = [], storage = opts.storage || new Map();
  const net = { offline: !!opts.offline, getHangs: !!opts.getHangs, holdSnaps: !!opts.holdSnaps };
  const ctx = {
    console: opts.boot === 'none' && !process.env.DEBUG_LOAD ? quietConsole : console,
    JSON, Math, Object, Array, Date, Promise, Error,
    setTimeout: (f, ms) => { const h = setTimeout(() => { timers.delete(h); if (!ctx.dead) f(); }, (ms || 0) / 20); timers.add(h); return h; }, // 1s debounce -> 50ms
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    localStorage: makeStorage(storage),
    LS_KEY: 'mexico-travel-data', SEED_DAYS: [], SEED_WISHLIST: [],
    STRINGS: { dpDow: { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], ko: ['일', '월', '화', '수', '목', '금', '토'] } },
    currentLang: opts.lang || 'en', currentUser: { uid: opts.uid || 'u' + name },
    DAYS: [], WISHLIST: [], currentTripId: null, currentTripMeta: null, DATA_REF: null,
    _tripDataConfirmed: false, _loadAncestor: null, _tripUid: null, _tripLoading: false, _tripMetaFresh: false, _isPublicView: false, _copyLockRelease: null,
    _saveDeferred: false, _saveEmptyTrip: null, _lastSaveTs: 0, saveTimer: null, _dataUnsub: null, _metaUnsub: null,
    editingWishId: null, _signingOut: false, _schedOrig: null, schedNotesDraft: null,
    _listenRetries: {}, _openTripGen: 0, _prevTripView: null, currentView: 'calendar', leafletMap: null,
    toasts: [], renders: 0, lang: opts.lang || 'en',
  };
  if (!opts.noLocks) ctx.navigator = { locks: makeLocks(storage, locks) };
  ctx.canEdit = () => true;
  ctx.t = k => k;
  ctx.showSaveToast = (m) => ctx.toasts.push(m);
  ctx.refreshDayLabels = () => { ctx.DAYS.forEach(d => { if (d.isoDate) d.date = ctx.lang + ':' + d.isoDate; }); };
  ctx.rerender = (noSave) => { ctx.renders++; if (!noSave) ctx.scheduleSave(); };
  ctx.lsLoadTripList = () => [Object.assign({ id: 'trip1' }, srv.meta)];
  ctx.document = { getElementById: () => ({ style: {} }) };
  ['_clampCalPage', 'destroyMap', '_enterTripChrome', '_closeTripModals', 'showLoginScreen', 'updateHeader', 'navigateTo',
   'updateShareBtnVisibility', 'updateFab', '_restoreCalPage', 'initMap', '_fitMapToMarkers', 'fetchWeather',
   '_geocodeMissingWishCoords', 'closeSchedModal', 'closeCalAdd', '_viewDayKeys', '_restoreViewDays', '_cacheTripMeta', '_clearStatusToast'].forEach(n => { ctx[n] = () => {}; });
  ctx.TOAST_CHECK = '';
  ctx._addBlocked = () => false; ctx.alert = () => {};
  ctx.catIcon = () => ''; ctx.CSS = { escape: s => String(s).replace(/["\\]/g, '\\$&') };
  // Lookups (geocoding, map-link expansion) go nowhere unless a scenario answers them (see lookups()).
  ctx.fetch = () => Promise.reject(new Error('no network in tests'));
  ctx._tripAccessEnded = (id, key) => { ctx.accessEnded = key; };
  ctx.confirm = () => true;
  ctx.closeWishModal = () => { ctx.editingWishId = null; };
  // Signing out: from then on the rules refuse this client's reads and writes; onAuthStateChanged(null) follows.
  ctx.auth = { signOut: () => { ctx.authGone = true; ctx.currentUser = null; ctx._leaveSignedOut(); return Promise.resolve(); } };
  const fsErr = (code) => { const e = new Error(code); e.code = code; return e; };
  const call = async (fn) => { await sleep(rnd()); if (ctx.dead) throw fsErr('cancelled'); if (net.offline) throw fsErr('unavailable'); if (ctx.authGone) throw fsErr('permission-denied'); return fn(); };
  // Snapshot listeners (the app's listenForRemoteChanges, or the direct feed of a 'synced' client): in-order
  // delivery with latency; while offline (or held) nothing arrives, and on reconnect the listener gets the
  // latest server state. With opts.coalesce, states that arrive while one is on its way collapse into the newest.
  const snapListeners = [];
  function feed(onNext) {
    let chain = Promise.resolve(), pending = null, scheduled = false;
    const l = { active: true, held: false, deliver(d) {
      if (!l.active || ctx.dead) return;
      if (net.offline || net.holdSnaps) { l.held = true; return; }
      if (opts.coalesce) {
        pending = d;
        if (!scheduled) {
          scheduled = true; srv.inDelivery++;
          setTimeout(() => {
            scheduled = false; srv.inDelivery--;
            const p = pending; pending = null; if (p && l.active && !ctx.dead) onNext(p);
          }, rnd());
        }
        return;
      }
      srv.inDelivery++;
      chain = chain.then(() => sleep(rnd())).then(() => { if (l.active && !ctx.dead) onNext(d); }).finally(() => { srv.inDelivery--; });
    } };
    srv.listeners.push(l); snapListeners.push(l);
    return l;
  }
  function dataRef(tripId) {
    return {
      id: 'main', parent: { parent: { id: tripId } },
      get: () => (net.getHangs ? new Promise(() => {}) : call(() => ({ exists: true, data: () => clone(srv.data) }))),
      onSnapshot(onNext) {
        const l = feed(d => onNext({ exists: true, data: () => clone(d), metadata: { fromCache: false, hasPendingWrites: false } }));
        l.deliver(clone(srv.data));
        return () => { l.active = false; };
      },
    };
  }
  ctx.db = {
    collection() { return { doc(id) { return {
      id, get: () => call(() => ({ exists: true, data: () => clone(srv.meta) })),
      onSnapshot(_opts, onNext) {
        const l = { active: true, ctx, onNext };
        srv.metaListeners.push(l);
        return () => { l.active = false; };
      },
      collection() { return { doc() { return dataRef(id); } }; },
    }; } }; },
    // Like the SDK's TransactionRunner: up to 5 attempts, the first at once and then an exponential backoff
    // (about 1s, x1.5 each time, +/-50% jitter; scaled like the app's timers). A doc that changed between the
    // read and the write is retried, and once attempts run out that is reported as 'failed-precondition'.
    runTransaction(fn) {
      return (async () => {
        let backoff = 0, lastErr = 'failed-precondition';
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt) { backoff = backoff ? backoff * 1.5 : 1000; await sleep(backoff * (0.5 + Math.random()) / 20); }
          await sleep(rnd());
          if (ctx.dead) throw fsErr('cancelled');
          if (net.offline) { if (opts.slowOffline) { lastErr = 'unavailable'; continue; } throw fsErr('unavailable'); } // Firestore transactions fail while offline
          if (ctx.authGone) throw fsErr('permission-denied');
          const readVersion = srv.version, readData = clone(srv.data);
          let write = null;
          const tx = {
            get: async () => { await sleep(rnd() / 2); return { exists: true, data: () => clone(readData) }; },
            set: (_r, d) => { write = clone(d); },
          };
          await fn(tx);
          await sleep(rnd());
          if (srv.storm > 0) { srv.storm--; srv.version++; }                  // someone else committed meanwhile
          if (srv.version !== readVersion) { srv.conflicts++; lastErr = 'failed-precondition'; continue; } // contention: retry
          if (ctx.dead) throw fsErr('cancelled'); // the page went away before the write reached the server
          if (ctx.authGone) throw fsErr('permission-denied'); // signed out before the commit reached the server
          if (write) {
            assertNoUndefined(write);
            if (srv.sizeLimit && JSON.stringify(write).length > srv.sizeLimit) throw fsErr('invalid-argument');
            if (process.env.DEBUG_REGRESS && write.wishlist && write.wishlist[0] && srv.data.wishlist[0]) {
              for (const k of Object.keys(srv.data.wishlist[0]).filter(k => k.startsWith('note_'))) {
                const num = v => v ? parseInt(String(v).replace(/\D/g, ''), 10) : -1;
                if (num(write.wishlist[0][k]) < num(srv.data.wishlist[0][k])) {
                  console.log('REGRESSION by', name, k, srv.data.wishlist[0][k], '->', write.wishlist[0][k]);
                  console.log('  last tx inputs:', JSON.stringify(ctx.__lastTx && ctx.__lastTx.map(x => x && x.wishlist && x.wishlist[0] && x.wishlist[0][k])));
                  console.log('  client local now:', ctx.WISHLIST[0][k], ' serverBase:', vm.runInContext('_serverBase && _serverBase.wishlist[0]', ctx) && vm.runInContext('_serverBase.wishlist[0]', ctx)[k]);
                  console.log('  events:', (ctx.__log || []).slice(-12).join(' | '));
                }
              }
            }
            const num = v => v ? parseInt(String(v).replace(/\D/g, ''), 10) : -1;
            const w0 = write.wishlist && write.wishlist[0], s0 = srv.data.wishlist && srv.data.wishlist[0];
            if (w0 && s0) Object.keys(s0).filter(k => k.startsWith('note_')).forEach(k => { if (num(w0[k]) < num(s0[k])) srv.regressions = (srv.regressions || 0) + 1; });
            if (process.env.DEBUG_DUP && !srv.dupReported) {
              const where = (dd, id) => (dd && dd.days || []).map((d, i) => d.events.some(e => e.id === id) ? d.isoDate.slice(-2) : null).filter(Boolean).join('+') || '-';
              const all = [].concat(...write.days.map(d => d.events.map(e => e.id)));
              const dup = all.find((x, i) => all.indexOf(x) !== i);
              if (dup) {
                srv.dupReported = true;
                const tx = ctx.__lastTx || [];
                console.log('DUP by', name, dup, 'server-before:', where(srv.data, dup), 'base:', where(tx[0], dup), 'local:', where(tx[1], dup), 'remote:', where(tx[2], dup));
                ['base','local','remote'].forEach((lab, j) => { const d = tx[j]; if (!d) return; d.days.forEach(day => day.events.filter(e => e.id === dup).forEach(e => console.log('   ', lab, day.isoDate, JSON.stringify(e)))); });
              }
            }
            srv.data = write; srv.version++; srv.commits++; srv.notify();
            if (opts.ackDelay) await sleep(opts.ackDelay);
          }
          return;
        }
        if (lastErr === 'failed-precondition') srv.exhausted++;
        throw fsErr(lastErr);
      })();
    },
  };
  vm.createContext(ctx);
  vm.runInContext(appSrc, ctx);
  if (process.env.DEBUG_REGRESS || process.env.DEBUG_DUP) {
    ctx.__log = [];
    const L = (m) => ctx.__log.push(m);
    const nf = o => o && o.wishlist && o.wishlist[0] ? Object.keys(o.wishlist[0]).filter(k=>k.startsWith('note_')).sort().map(k=>o.wishlist[0][k]).join('/') : '-';
    ctx.__dbg = (tag, sent, now, merged, live) => L(tag + ' live=' + live + ' sent=' + nf(sent) + ' now=' + nf(now) + ' merged=' + nf(merged) + ' rev=' + merged.rev);
    const origMerge = ctx._mergeTripData;
    ctx._mergeTripData = function (b, l, r) {
      ctx.__lastTx = [b, l, r].map(x => x && JSON.parse(JSON.stringify(x)));
      const out = origMerge(b, l, r);
      if (process.env.DEBUG_DUP && !global.__dupMergeReported) {
        const ids = x => [].concat(...((x && x.days) || []).map(d => d.events.map(e => e.id)));
        const dupOf = x => { const a = ids(x); return a.find((v, i) => a.indexOf(v) !== i); };
        const d = dupOf(out);
        if (d && !dupOf(l) && !dupOf(r)) {
          global.__dupMergeReported = true;
          const where = (dd) => (dd && dd.days || []).map(day => day.events.some(e => e.id === d) ? day.isoDate.slice(-2) : null).filter(Boolean).join('+') || '-';
          console.log('MERGE CREATED DUP in', name, d, 'base:', where(b), 'local:', where(l), 'remote:', where(r), '=> out:', where(out));
          console.log('   stack:', new Error().stack.split('\n').slice(2, 5).map(x => x.trim()).join(' <- '));
        }
      }
      return out;
    };
    vm.runInContext('_mergeTripData = this._mergeTripData', ctx);
    const origSnap = ctx._onTripDataSnapshot;
    ctx._onTripDataSnapshot = function (id, snap) {
      const d = snap.data(); L('snap(' + (d.wishlist[0] && Object.keys(d.wishlist[0]).filter(k=>k.startsWith('note_')).map(k=>k+'='+d.wishlist[0][k]).join(',')) + ') base-before=' + JSON.stringify(ctx._serverBase && ctx._serverBase.wishlist[0] && Object.keys(ctx._serverBase.wishlist[0]).filter(k=>k.startsWith('note_')).map(k=>ctx._serverBase.wishlist[0][k])));
      return origSnap(id, snap);
    };
    vm.runInContext('_onTripDataSnapshot = this._onTripDataSnapshot', ctx);
    const origSet = ctx._setServerBase;
    ctx._setServerBase = function (d) {
      const src = (new Error().stack.split('\n')[2] || '').trim().split(' ')[1];
      const na = d && d.wishlist && d.wishlist[0] && d.wishlist[0].note_A;
      L('setBase[' + src + '] base.note_A=' + na + ' rev=' + (d && d.rev) + ' local.note_A=' + (ctx.WISHLIST[0] && ctx.WISHLIST[0].note_A));
      return origSet(d);
    };
    vm.runInContext('_setServerBase = this._setServerBase', ctx);
  }
  if (opts.boot !== 'none') {
    // Already on the trip, loaded from the server; snapshots go straight to the sync code.
    ctx.currentTripId = 'trip1'; ctx.currentTripMeta = { startDate: '2026-10-01', type: 'trip' }; ctx._tripDataConfirmed = true;
    ctx._tripUid = ctx.currentUser.uid;
    ctx.DATA_REF = dataRef('trip1');
    feed(d => {
      if (ctx.detached || ctx.dead) return;
      ctx._onTripDataSnapshot('trip1', { exists: true, data: () => clone(d), metadata: { hasPendingWrites: false } });
      if (ctx.myNote && ctx.WISHLIST[0] && ctx.WISHLIST[0]['note_' + name] !== ctx.myNote) ctx.flickers = (ctx.flickers || 0) + 1;
    });
    ctx.DAYS = clone(srv.data.days); ctx.WISHLIST = clone(srv.data.wishlist);
    ctx.__init = clone(srv.data);
    vm.runInContext('_setServerBase(__init)', ctx);
  }
  ctx.name = name;
  ctx.net = net;
  ctx.edit = (fn) => { fn(ctx); ctx.rerender(); }; // user edit -> debounced save
  ctx.v = (expr) => vm.runInContext(expr, ctx);
  ctx.open = () => ctx.openTrip('trip1');
  ctx.goOffline = () => { net.offline = true; };
  ctx.goOnline = () => {
    net.offline = false; net.holdSnaps = false;
    snapListeners.forEach(l => { if (l.active && l.held) { l.held = false; l.deliver(clone(srv.data)); } });
  };
  // Reload / tab discard / closed tab: JS state and timers are gone, localStorage stays.
  ctx.discard = () => { ctx.dead = true; timers.forEach(h => clearTimeout(h)); timers.clear(); snapListeners.forEach(l => { l.active = false; }); locks.forEach(l => l.release()); };
  return ctx;
}
function assertNoUndefined(o, path = '') {
  if (o === undefined) throw new Error('undefined value at ' + path);
  if (o && typeof o === 'object') for (const k in o) assertNoUndefined(o[k], path + '.' + k);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settle(clients, srv) {
  // wait until no timers, commits or snapshot deliveries are pending (then every client should match the server)
  const busy = () => (srv && srv.inDelivery > 0) || clients.some(c => c.saveTimer || vm.runInContext('_commitsInFlight', c));
  for (let i = 0; i < 400; i++) {
    await sleep(30);
    if (!busy()) {
      await sleep(120);
      if (!busy()) return;
    }
  }
  throw new Error('did not settle');
}
const deq = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') return Object.keys(o).sort().reduce((r, k) => (r[k] = sortKeys(o[k]), r), {});
  return o;
}
function stripLabels(d) { const c = { days: clone(d.days), wishlist: clone(d.wishlist) }; c.days.forEach(x => delete x.date); return c; }
function converged(clients, srv) {
  clients.forEach(c => assert(deq(stripLabels({ days: c.DAYS, wishlist: c.WISHLIST }), stripLabels(srv.data)),
    c.name + ' diverged from server'));
}
const baseTrip = () => ({
  days: [
    { id: 'd1', isoDate: '2026-10-01', date: 'x', theme: '', events: [{ id: 'ev_1', time: '10:00', endTime: '11:00', title: 'Coffee', notes: '' }] },
    { id: 'd2', isoDate: '2026-10-02', date: 'x', theme: '', events: [] },
  ],
  wishlist: [
    { id: 'w1', name: 'Blue Bottle', category: 'food' },
    { id: 'w2', name: 'Park Hyatt', category: 'hotel' },
    { id: 'w3', name: 'teamLab', category: 'culture' },
  ],
});
// Reload scenarios: a dated trip whose days carry real theme/color/lodging, opened through openTrip.
const META = { name: 'Tokyo', startDate: '2026-10-01', endDate: '2026-10-02', coverColor: '#6366f1', type: 'trip' };
const datedTrip = () => ({
  days: [
    { id: 'd1', isoDate: '2026-10-01', date: 'en:2026-10-01', theme: 'Arrival', color: '#f97316', lodgingWishId: 'w2', events: [{ id: 'ev_1', time: '09:00', title: 'Breakfast', notes: '' }] },
    { id: 'd2', isoDate: '2026-10-02', date: 'en:2026-10-02', theme: 'Museums', color: '#10b981', events: [] },
  ],
  wishlist: [{ id: 'w1', name: 'Museum' }, { id: 'w2', name: 'Park Hyatt', category: 'hotel', notes: 'orig' }],
  rev: 1,
});
const page = (name, srv, storage, opts = {}) => makeClient(name, srv, Object.assign({ boot: 'none', storage, uid: 'uA' }, opts));
async function waitFor(what, cond, ms = 6000) {
  for (let t = 0; t < ms; t += 10) { if (cond()) return; await sleep(10); }
  throw new Error('timed out waiting for ' + what);
}
const place = (d, id) => (d.WISHLIST || d.wishlist || []).find(w => w.id === id); // a client or a data object
const copyKeys = (storage) => Array.from(storage.keys()).filter(k => k.indexOf('travel-data-trip1~') === 0);
const cacheOf = (storage) => JSON.parse(storage.get('travel-data-trip1') || 'null');
const heldBy = (storage, s) => Array.from(storage.entries()).filter(([, v]) => v.includes(s)).map(([k]) => k);
// The real schedule-modal and calendar-add saves, with their form filled in.
function form(c, values) {
  const els = {};
  Object.keys(values).forEach(k => { els[k] = { style: {}, value: values[k] }; });
  c.document = { getElementById: id => els[id] || { style: {} } };
}
function schedule(c, wishId, dayId, startMin, notes) {
  Object.assign(c, { schedWishId: wishId, schedDayId: dayId, schedStartMin: startMin, schedDurMin: 60, _schedOrig: null });
  form(c, { schedNotes: notes || '' }); c.saveSchedule();
}
// The schedule modal opened on a place (what openSchedModal sets up, without drawing it); saveSchedule later.
function openSched(c, wishId) { c.schedWishId = wishId; c._schedStart(place(c, wishId)); }
function calAdd(c, wishId, dayId, startMin, notes) {
  Object.assign(c, { calAddWishId: wishId, calAddDayId: dayId, calAddStartMin: startMin, calAddMode: 'place' });
  form(c, { calAddDurSlider: '1', calAddPlaceNotes: notes || '' }); c.saveCalAdd();
}
// Holds this client's lookups until the scenario answers them: answer(urlPart, body).
function lookups(c) {
  const pending = [];
  c.fetch = url => new Promise(resolve => pending.push({ url, resolve }));
  return {
    count: () => pending.length,
    answer(part, body) {
      const i = pending.findIndex(p => p.url.includes(part)); assert(i >= 0, 'no lookup for ' + part);
      pending.splice(i, 1)[0].resolve({ json: async () => body });
    },
  };
}
// A stand-in for the open calendar-add modal's DOM: the list holds whatever renderCalAddWishList last wrote, and
// focus() moves document.activeElement.
function calAddDom(c) {
  const els = { calAddModal: { classList: { contains: k => k === 'open' } }, calAddWishList: { innerHTML: '' }, calAddGone: { textContent: '' } };
  const btns = () => [...els.calAddWishList.innerHTML.matchAll(/<button [^>]*>/g)].map(m => m[0]);
  const el = tag => tag && { tag,
    getAttribute: a => (new RegExp(' ' + a + '="([^"]*)"').exec(tag) || [])[1] || null,
    closest: sel => (sel === '#calAddWishList' && btns().includes(tag) ? els.calAddWishList : null),
    focus() { c.document.activeElement = this; } };
  els.calAddModal.querySelector = sel => (sel === '.modal-close' ? el('<button class="modal-close">') : null);
  c.document = { activeElement: null, getElementById: id => els[id] || { style: {} }, querySelector(sel) {
    const all = btns(), m = /\[data-wid="([^"]*)"\]$/.exec(sel);
    if (m) return el(all.find(b => b.includes('data-wid="' + m[1] + '"')));
    if (/ \.selected$/.test(sel)) return el(all.find(b => /class="[^"]*\bselected\b/.test(b)));
    if (/ button$/.test(sel)) return el(all[0]);
    return null;
  } };
  return els;
}
// [dayId, event] for every event with this id (in a client or a data object)
const evsWithId = (d, id) => [].concat(...(d.DAYS || d.days).map(day => day.events.filter(e => e.id === id).map(e => [day.id, e])));
// No event id twice, and every place's link names an event that exists and the day it's on.
function linksOk(d, what) {
  const dayOf = {}, ids = [];
  d.days.forEach(day => day.events.forEach(e => { ids.push(e.id); dayOf[e.id] = day.id; }));
  assert.strictEqual(new Set(ids).size, ids.length, what + ': the same event twice');
  d.wishlist.forEach(w => { if (w.calEventId) assert.strictEqual(dayOf[w.calEventId], w.calDayId, what + ': ' + w.id + ' links to ' + w.calDayId + '/' + w.calEventId); });
}
// baseTrip with teamLab (w3) scheduled on day 1
const scheduledTrip = (evId = 'wl_ev_w3') => {
  const t = baseTrip();
  t.days[0].events.push({ id: evId, title: 'teamLab', time: '14:00', endTime: '15:00', notes: '' });
  Object.assign(t.wishlist[2], { calDayId: 'd1', calEventId: evId, visited: true, dayLabel: 'x' });
  return t;
};

// ---------- unit tests of the pure merge ----------
function unit() {
  const c = makeClient('u', makeServer(baseTrip()));
  const M = (b, l, r) => vm.runInContext('_mergeTripData', c)(clone(b), clone(l), clone(r));
  const b = baseTrip();
  let l, r, m;
  // both add different places
  l = clone(b); l.wishlist.push({ id: 'wa', name: 'A' });
  r = clone(b); r.wishlist.push({ id: 'wb', name: 'B' });
  m = M(b, l, r); assert.deepStrictEqual(m.wishlist.map(w => w.id), ['w1', 'w2', 'w3', 'wb', 'wa']);
  // same event, different fields
  l = clone(b); l.days[0].events[0].time = '12:00';
  r = clone(b); r.days[0].events[0].notes = 'bring cash';
  m = M(b, l, r); assert.strictEqual(m.days[0].events[0].time, '12:00'); assert.strictEqual(m.days[0].events[0].notes, 'bring cash');
  // same field conflict: local wins
  l = clone(b); l.wishlist[0].name = 'L'; r = clone(b); r.wishlist[0].name = 'R';
  assert.strictEqual(M(b, l, r).wishlist[0].name, 'L');
  // delete here vs untouched remotely -> deleted
  l = clone(b); l.wishlist = l.wishlist.filter(w => w.id !== 'w3'); r = clone(b);
  assert(!M(b, l, r).wishlist.some(w => w.id === 'w3'));
  // delete here vs edited remotely -> kept with the edit
  r = clone(b); r.wishlist[2].notes = 'go at 9';
  m = M(b, l, r); assert.strictEqual(m.wishlist.find(w => w.id === 'w3').notes, 'go at 9');
  // deleted remotely vs untouched here -> deleted; vs edited here -> kept
  l = clone(b); r = clone(b); r.wishlist.pop();
  assert(!M(b, l, r).wishlist.some(w => w.id === 'w3'));
  l.wishlist[2].notes = 'mine'; assert(M(b, l, r).wishlist.some(w => w.id === 'w3'));
  // votes: both vote -> both kept
  l = clone(b); l.wishlist[0].votes = { uA: { name: 'A' } };
  r = clone(b); r.wishlist[0].votes = { uB: { name: 'B' } };
  assert.deepStrictEqual(Object.keys(M(b, l, r).wishlist[0].votes).sort(), ['uA', 'uB']);
  // unvote here while other votes
  const bv = clone(b); bv.wishlist[0].votes = { uA: { name: 'A' } };
  l = clone(bv); delete l.wishlist[0].votes.uA;
  r = clone(bv); r.wishlist[0].votes.uB = { name: 'B' };
  assert.deepStrictEqual(Object.keys(M(bv, l, r).wishlist[0].votes), ['uB']);
  // event moved between days here, remote untouched -> exactly one copy on the new day
  l = clone(b); const ev = l.days[0].events.pop(); l.days[1].events.push(ev);
  m = M(b, l, clone(b)); assert.strictEqual(m.days[0].events.length, 0); assert.strictEqual(m.days[1].events.length, 1);
  // same new date created on both sides with different ids -> one day, server id, calDayId remapped
  l = clone(b); l.days.push({ id: 'dL', isoDate: '2026-10-03', events: [{ id: 'wl_ev_x', title: 'x' }] });
  l.wishlist[1].calDayId = 'dL';
  r = clone(b); r.days.push({ id: 'dR', isoDate: '2026-10-03', events: [] });
  m = M(b, l, r);
  const d3 = m.days.filter(d => d.isoDate === '2026-10-03'); assert.strictEqual(d3.length, 1);
  assert.strictEqual(d3[0].id, 'dR'); assert.strictEqual(d3[0].events.length, 1);
  assert.strictEqual(m.wishlist[1].calDayId, 'dR');
  // key order differences are not changes
  const reordered = sortKeys(clone(b)); reordered.wishlist.reverse(); reordered.wishlist.reverse();
  assert(deq(M(b, clone(b), reordered), b));
  // pre-existing duplicate ids survive
  const dup = clone(b); dup.wishlist.push({ id: 'w1', name: 'dupe' });
  assert.strictEqual(M(dup, clone(dup), clone(dup)).wishlist.length, 4);
  // null base (unknown ancestor) never deletes
  l = clone(b); l.wishlist.pop(); assert.strictEqual(M(null, l, clone(b)).wishlist.length, 3);
  // days stay sorted by date
  r = clone(b); r.days.reverse(); assert.deepStrictEqual(M(b, clone(b), r).days.map(d => d.isoDate), ['2026-10-01', '2026-10-02']);
  // Derived and auto-filled fields never decide delete versus edit. A dated day's labels (each viewer's
  // language): a day removed remotely stays removed although this side relabeled it, and the labels kept are the
  // server's (a day only this side has keeps its own).
  const lb = clone(b); lb.days.forEach(d => { d.date = 'en:' + d.isoDate; d.dayName = 'Thu'; });
  l = clone(lb); l.days.forEach(d => { d.date = 'ko:' + d.isoDate; d.dayName = '목'; });
  l.days.push({ id: 'd3', isoDate: '2026-10-03', date: 'ko:2026-10-03', dayName: '토', events: [] });
  r = clone(lb); r.days.pop();
  assert.deepStrictEqual(M(lb, l, r).days.map(d => [d.id, d.date, d.dayName]), [['d1', 'en:2026-10-01', 'Thu'], ['d3', 'ko:2026-10-03', '토']]);
  // Coordinates from a background lookup (and a place's day label) don't keep a deleted place or event
  l = clone(b); Object.assign(l.wishlist[2], { lat: 35.6, lng: 139.7, dayLabel: '10/1' }); r = clone(b); r.wishlist.pop();
  assert(!M(b, l, r).wishlist.some(w => w.id === 'w3'), 'geocoded here, deleted remotely: came back');
  l = clone(b); l.wishlist.pop(); r = clone(b); Object.assign(r.wishlist[2], { lat: 35.6, lng: 139.7 });
  assert(!M(b, l, r).wishlist.some(w => w.id === 'w3'), 'deleted here, geocoded remotely: came back');
  r.wishlist[2].notes = 'go early'; assert(M(b, l, r).wishlist.some(w => w.id === 'w3'), 'a real edit no longer keeps it');
  l = clone(b); Object.assign(l.days[0].events[0], { lat: 35.6, lng: 139.7 }); r = clone(b); r.days[0].events = [];
  assert.strictEqual(M(b, l, r).days[0].events.length, 0, 'event geocoded here, deleted remotely: came back');

  // Places stay linked to their calendar events.
  const sb = scheduledTrip(); sb.days[1].date = 'Oct 2';
  const link = (d, id) => { const w = place(d, id); return w && [w.calDayId, w.calEventId, w.visited, w.dayLabel]; };
  assert(deq(M(sb, clone(sb), clone(sb)), sb), 'an unchanged, consistent trip changed');
  // the link follows its event to another day (moved by a copy of the app that left calDayId behind)
  l = clone(sb); l.wishlist[2].notes = 'n';
  r = clone(sb); r.days[1].events.push(r.days[0].events.pop());
  assert.deepStrictEqual(link(M(sb, l, r), 'w3'), ['d2', 'wl_ev_w3', true, 'Oct 2']);
  // deleted here while voted on remotely: the vote keeps the place, but its event is gone, so it's unscheduled
  l = clone(sb); l.days[0].events.pop(); l.wishlist.pop();
  r = clone(sb); r.wishlist[2].votes = { uB: { name: 'B' } };
  m = M(sb, l, r);
  assert.deepStrictEqual(link(m, 'w3'), [null, null, false, '']); assert(m.wishlist[2].votes.uB);
  // unscheduled here while its event was edited remotely: the edit keeps the event, and the place links back to it
  l = clone(sb); l.days[0].events.pop(); Object.assign(l.wishlist[2], { calDayId: null, calEventId: null, visited: false, dayLabel: '' });
  r = clone(sb); r.days[0].events[1].notes = 'booked';
  m = M(sb, l, r);
  assert.strictEqual(m.days[0].events[1].notes, 'booked'); assert.deepStrictEqual(link(m, 'w3'), ['d1', 'wl_ev_w3', true, 'x']);
  // events on a day the other side removed (a date change) go on the last day, tagged with their date, and a
  // place follows its event there
  l = clone(sb); l.days[1].events.push(l.days[0].events.pop()); Object.assign(l.wishlist[2], { calDayId: 'd2', dayLabel: 'Oct 2' });
  l.days[1].events.push({ id: 'ev_new', time: '09:00', title: 'Brunch', notes: 'window seat' });
  r = clone(sb); r.days.pop();
  m = M(sb, l, r);
  assert.deepStrictEqual(m.days.map(d => d.id), ['d1']);
  assert.deepStrictEqual(m.days[0].events.map(e => [e.id, e.notes]), [['ev_1', ''], ['wl_ev_w3', '[originalDate 2026-10-02] '], ['ev_new', '[originalDate 2026-10-02] window seat']]);
  assert.deepStrictEqual(link(m, 'w3'), ['d1', 'wl_ev_w3', true, 'x']);
  assert.strictEqual(l.days[1].events[1].notes, 'window seat', 'the merge changed its input');
  // the same place scheduled on both sides at once (its event id comes from the place): one event, fields merged
  l = clone(b); l.days[0].events.push({ id: 'wl_ev_w3', title: 'teamLab', time: '14:00' }); Object.assign(l.wishlist[2], { calDayId: 'd1', calEventId: 'wl_ev_w3', visited: true });
  r = clone(b); r.days[1].events.push({ id: 'wl_ev_w3', title: 'teamLab', time: '16:00', notes: 'r' }); Object.assign(r.wishlist[2], { calDayId: 'd2', calEventId: 'wl_ev_w3', visited: true });
  m = M(b, l, r);
  assert.deepStrictEqual(evsWithId(m, 'wl_ev_w3').map(([d, e]) => [d, e.time, e.notes]), [['d1', '14:00', 'r']]);
  assert.deepStrictEqual(link(m, 'w3').slice(0, 2), ['d1', 'wl_ev_w3']);
  // moved to another day here (same event id) while deleted remotely: the move is an edit, so place and event stay,
  // linked on the new day
  l = clone(sb); l.days[1].events.push(l.days[0].events.pop()); Object.assign(l.wishlist[2], { calDayId: 'd2', dayLabel: 'Oct 2' });
  r = clone(sb); r.days[0].events.pop(); r.wishlist.pop();
  m = M(sb, l, r);
  assert.deepStrictEqual(evsWithId(m, 'wl_ev_w3').map(([d]) => d), ['d2']); assert.deepStrictEqual(link(m, 'w3'), ['d2', 'wl_ev_w3', true, 'Oct 2']);
  // a stale link (legacy data: calDayId names another day than its event's) repaired by one commit is not an
  // edit: a delete made meanwhile from the unrepaired copy sticks
  const stale = clone(sb); stale.days[1].events.push(stale.days[0].events.pop());      // event on d2, link says d1
  const repaired = M(stale, clone(stale), clone(stale));
  assert.deepStrictEqual(link(repaired, 'w3'), ['d2', 'wl_ev_w3', true, 'Oct 2']);
  assert.strictEqual(place(stale, 'w3').calDayId, 'd1', 'the merge changed its input');
  l = clone(stale); l.days[1].events = []; l.wishlist.pop();
  m = M(stale, l, repaired);
  assert(!place(m, 'w3') && !evsWithId(m, 'wl_ev_w3').length, 'the repair brought back a deleted place');
  m = M(stale, repaired, l);                                                            // the other way round
  assert(!place(m, 'w3') && !evsWithId(m, 'wl_ev_w3').length, 'the repair kept a place deleted remotely');
  // Places the calendar-add modal offers: not yet scheduled, or a hotel / transport (one event per night or leg)
  const offered = w => c._calAddOffered(w);
  assert(offered({ id: 'a', category: 'food' }), 'an unscheduled place is not offered');
  assert(!offered({ id: 'a', category: 'food', calDayId: 'd1', calEventId: 'wl_ev_a' }), 'a scheduled place is offered again');
  assert(offered({ id: 'a', category: 'hotel', calDayId: 'd1', calEventId: 'wl_ev_x' }), 'a scheduled hotel is not offered for another night');
  assert(offered({ id: 'a', category: 'transport', calDayId: 'd1', calEventId: 'wl_ev_y' }), 'a scheduled leg is not offered again');
  assert(!offered({ id: 'a', wishType: 'note' }), 'a note is offered as a place');
  console.log('unit: merge cases OK');
}

// ---------- multi-client scenarios ----------
async function scenario(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY=<part of a name> runs just those
  const t0 = Date.now();
  await fn();
  console.log('scenario OK: ' + name + ' (' + (Date.now() - t0) + 'ms)');
}
async function main() {
  unit();

  await scenario('simultaneous adds from two people both survive', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    A.edit(c => c.WISHLIST.push({ id: 'wa', name: 'A place' }));
    B.edit(c => c.WISHLIST.push({ id: 'wb', name: 'B place' }));
    await settle([A, B], srv);
    assert(srv.data.wishlist.some(w => w.id === 'wa') && srv.data.wishlist.some(w => w.id === 'wb'));
    converged([A, B], srv);
  });

  await scenario('same event, different fields, edited at once', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    A.edit(c => { c.DAYS[0].events[0].time = '13:00'; });
    B.edit(c => { c.DAYS[0].events[0].notes = 'reservation 1pm'; });
    await settle([A, B], srv);
    const ev = srv.data.days[0].events[0];
    assert.strictEqual(ev.time, '13:00'); assert.strictEqual(ev.notes, 'reservation 1pm');
    converged([A, B], srv);
  });

  await scenario('delete vs concurrent edit keeps the edit; other deletes stick', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    A.edit(c => { c.WISHLIST = c.WISHLIST.filter(w => w.id !== 'w3' && w.id !== 'w2'); });
    B.edit(c => { c.WISHLIST.find(w => w.id === 'w3').notes = 'must see'; });
    await settle([A, B], srv);
    assert(!srv.data.wishlist.some(w => w.id === 'w2'), 'w2 delete stuck');
    assert.strictEqual(srv.data.wishlist.find(w => w.id === 'w3').notes, 'must see');
    converged([A, B], srv);
  });

  await scenario('two people voting on the same place at once', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv), C = makeClient('C', srv);
    [A, B, C].forEach(c => c.edit(x => { const w = x.WISHLIST[0]; w.votes = w.votes || {}; w.votes['u' + c.name] = { name: c.name }; }));
    await settle([A, B, C], srv);
    assert.deepStrictEqual(Object.keys(srv.data.wishlist[0].votes).sort(), ['uA', 'uB', 'uC']);
    converged([A, B, C], srv);
  });

  await scenario('edit made while a save is in flight is not lost', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv, { latency: [40, 80] }), B = makeClient('B', srv);
    A.edit(c => c.WISHLIST.push({ id: 'first', name: '1' }));
    await sleep(60); // debounce fired, commit in flight
    A.WISHLIST.push({ id: 'second', name: '2' }); A.rerender();
    B.edit(c => c.WISHLIST.push({ id: 'fromB', name: 'B' }));
    await settle([A, B], srv);
    ['first', 'second', 'fromB'].forEach(id => assert(srv.data.wishlist.some(w => w.id === id), id + ' missing'));
    converged([A, B], srv);
  });

  await scenario('save flushed while leaving the trip still lands', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv);
    A.edit(c => c.WISHLIST.push({ id: 'lastSecond', name: 'x' }));
    // what _detachTrip does: flush, then clear state in the same tick
    vm.runInContext('if (saveTimer) { clearTimeout(saveTimer); doSave(); } DATA_REF = null; currentTripId = null; _setServerBase(null);', A);
    A.detached = true;
    await sleep(600);
    assert(srv.data.wishlist.some(w => w.id === 'lastSecond'));
  });

  await scenario('both clients add the same new date (different day ids)', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    A.edit(c => { c.DAYS.push({ id: 'dA3', isoDate: '2026-10-03', events: [] }); c.WISHLIST[1].calDayId = 'dA3'; c.DAYS[2].events.push({ id: 'wl_ev_h', title: 'Park Hyatt' }); c.WISHLIST[1].calEventId = 'wl_ev_h'; });
    B.edit(c => { c.DAYS.push({ id: 'dB3', isoDate: '2026-10-03', events: [] }); });
    await settle([A, B], srv);
    const d3 = srv.data.days.filter(d => d.isoDate === '2026-10-03');
    assert.strictEqual(d3.length, 1, 'one day per date');
    assert.strictEqual(d3[0].events.length, 1);
    assert.strictEqual(srv.data.wishlist[1].calDayId, d3[0].id, 'place points at the surviving day');
    converged([A, B], srv);
  });

  await scenario('different UI languages do not ping-pong saves', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv, { lang: 'ko' }), B = makeClient('B', srv, { lang: 'en' });
    A.edit(c => c.refreshDayLabels());
    B.edit(c => c.refreshDayLabels());
    await settle([A, B], srv);
    const commits = srv.commits;
    await sleep(800);
    assert.strictEqual(srv.commits, commits, 'no saves while idle');
  });

  await scenario('stress: 3 people, 60 random interleaved edits, nothing lost', async () => {
    const srv = makeServer(baseTrip());
    const cs = ['A', 'B', 'C'].map(n => makeClient(n, srv, { latency: [2, 60] }));
    const expectAdded = [], expectNotes = {};
    for (let i = 0; i < 60; i++) {
      const c = cs[i % 3], kind = Math.floor(Math.random() * 3), id = c.name + i;
      if (kind === 0) { c.edit(x => x.WISHLIST.push({ id, name: 'place ' + id })); expectAdded.push(id); }
      else if (kind === 1) { c.edit(x => { const d = x.DAYS[i % x.DAYS.length]; d.events.push({ id: 'ev_' + id, time: '09:00', title: id }); }); expectAdded.push('ev_' + id); }
      else {
        // edit a field only this client owns on a shared item
        c.edit(x => { const w = x.WISHLIST[0]; w['note_' + c.name] = id; }); expectNotes['note_' + c.name] = id; c.myNote = id;
      }
      await sleep(Math.random() * 40);
    }
    await settle(cs, srv);
    const allIds = new Set(srv.data.wishlist.map(w => w.id).concat(...srv.data.days.map(d => d.events.map(e => e.id))));
    expectAdded.forEach(id => assert(allIds.has(id), 'lost ' + id));
    Object.keys(expectNotes).forEach(k => assert.strictEqual(srv.data.wishlist[0][k], expectNotes[k], 'lost latest ' + k));
    converged(cs, srv);
    const errToasts = cs.reduce((n, c) => n + c.toasts.filter(t => /saveFailed/.test(t)).length, 0);
    const flickers = cs.reduce((n, c) => n + (c.flickers || 0), 0);
    assert.strictEqual(srv.regressions || 0, 0, 'server value went backwards');
    assert.strictEqual(flickers, 0, 'a user saw their own edit revert');
    console.log('   commits=' + srv.commits + ' transaction retries=' + srv.conflicts + ' error toasts shown=' + errToasts + ' regressions=0 flickers=0');
  });

  await scenario('chaos: 5 people, 150 mixed ops incl. deletes, moves, votes, same-field edits', async () => {
    const srv = makeServer(baseTrip());
    const cs = ['A', 'B', 'C', 'D', 'E'].map(n => makeClient(n, srv, { latency: [1, 120] }));
    const kept = new Set(), mine = {};
    for (let i = 0; i < 150; i++) {
      const c = cs[Math.floor(Math.random() * cs.length)], id = c.name + i, op = Math.floor(Math.random() * 7);
      c.edit(x => {
        if (op === 0) { x.WISHLIST.push({ id, name: 'p' + id }); kept.add(id); }
        else if (op === 1) { // delete a place this person added earlier (never one others rely on)
          const own = x.WISHLIST.filter(w => w.id.startsWith(c.name) && !kept.has(w.id + ':keep'));
          if (own.length) { const w = own[0]; x.WISHLIST = x.WISHLIST.filter(v => v !== w); kept.delete(w.id); }
        }
        else if (op === 2) { x.WISHLIST[0].shared = id; }                           // same field, everyone
        else if (op === 3) { x.WISHLIST[1]['mine_' + c.name] = id; mine['mine_' + c.name] = id; }
        else if (op === 4) { const d = x.DAYS[i % x.DAYS.length]; d.events.push({ id: 'ev_' + id, time: '08:00', title: id }); kept.add('ev_' + id); }
        else if (op === 5) { // move an event to the other day
          const from = x.DAYS.find(d => d.events.length); if (from) { const ev = from.events.shift(); x.DAYS.find(d => d !== from).events.push(ev); }
        }
        else { const w = x.WISHLIST[2]; w.votes = w.votes || {}; if (w.votes['u' + c.name]) delete w.votes['u' + c.name]; else w.votes['u' + c.name] = { name: c.name }; }
      });
      await sleep(Math.random() * 25);
    }
    await settle(cs, srv);
    converged(cs, srv);
    const ids = srv.data.wishlist.map(w => w.id), evIds = [].concat(...srv.data.days.map(d => d.events.map(e => e.id)));
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate place ids');
    assert.strictEqual(new Set(evIds).size, evIds.length, 'duplicate/cloned events');
    kept.forEach(k => assert(ids.includes(k) || evIds.includes(k), 'lost ' + k));
    Object.keys(mine).forEach(k => assert.strictEqual(srv.data.wishlist[1][k], mine[k], 'lost latest ' + k));
    assert.strictEqual(srv.regressions || 0, 0);
    console.log('   commits=' + srv.commits + ' retries=' + srv.conflicts + ' places=' + ids.length + ' events=' + evIds.length);
  });

  await scenario('offline/failed save retries until it lands', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv);
    const real = A.db.runTransaction; let fails = 2;
    A.db.runTransaction = function (fn) { if (fails-- > 0) { const e = new Error('offline'); e.code = 'unavailable'; return Promise.reject(e); } return real.call(this, fn); };
    A.edit(c => c.WISHLIST.push({ id: 'offlineEdit', name: 'x' }));
    for (let i = 0; i < 100 && !srv.data.wishlist.some(w => w.id === 'offlineEdit'); i++) await sleep(50);
    assert(srv.data.wishlist.some(w => w.id === 'offlineEdit'), 'retry never landed');
    assert(A.toasts.some(t => /saveFailed/.test(t)), 'user was told about the failure');
  });

  await scenario('cache-time edits merge with newer server data on first snapshot', async () => {
    const cached = baseTrip();
    const srv = makeServer(baseTrip());
    srv.data.wishlist.push({ id: 'addedByOther', name: 'o' });     // server moved on while we were away
    const A = makeClient('A', srv);
    // simulate cache-first open: rendered from cache, user edits before the server answers
    A.DAYS = clone(cached.days); A.WISHLIST = clone(cached.wishlist);
    A._loadAncestor = clone(cached); A._tripDataConfirmed = false;
    vm.runInContext('_setServerBase(null)', A);
    A.WISHLIST.push({ id: 'editedFromCache', name: 'c' }); A._saveDeferred = true;
    vm.runInContext('_applyFirstServerSnapshot("trip1", ' + JSON.stringify(srv.data) + ')', A);
    await settle([A], srv);
    assert(srv.data.wishlist.some(w => w.id === 'addedByOther'));
    assert(srv.data.wishlist.some(w => w.id === 'editedFromCache'));
  });

  // ---------- reloads: the trip cache carries unsaved edits and their sync ancestor ----------
  await scenario('offline add + edit, reload, reconnect: both land next to a collaborator\'s change', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A1 = page('A1', srv, store); await A1.open();
    await waitFor('first open confirmed', () => A1._tripDataConfirmed);
    const B = makeClient('B', srv);
    A1.goOffline();
    A1.edit(c => { c.WISHLIST.push({ id: 'offlineAdd', name: 'Bakery' }); place(c, 'w2').notes = 'offline note'; });
    await waitFor('offline save to fail', () => A1.v('_saveFailCount') > 0);
    B.edit(c => { place(c, 'w1').name = 'Museum (B)'; c.WISHLIST.push({ id: 'fromB', name: 'B' }); });
    await settle([B], srv);
    A1.discard();                                        // reload while still offline
    const A2 = page('A2', srv, store, { offline: true }); await A2.open();
    assert(place(A2, 'offlineAdd') && place(A2, 'w2').notes === 'offline note', 'cache-first render shows the offline edits');
    A2.goOnline();
    await waitFor('reconnect', () => A2._tripDataConfirmed);
    await settle([A2, B], srv);
    assert(place(srv.data, 'offlineAdd'), 'offline add lost');
    assert.strictEqual(place(srv.data, 'w2').notes, 'offline note', 'offline edit lost');
    assert(place(srv.data, 'fromB') && place(srv.data, 'w1').name === 'Museum (B)', 'collaborator change lost');
    assert.strictEqual(srv.data.days[0].theme, 'Arrival');
    converged([A2, B], srv);
    assert.deepStrictEqual(copyKeys(store), [], 'nothing left marked unsaved');
    const rec = cacheOf(store);
    assert(!('base' in rec) && rec.rev === srv.data.rev && deq(stripLabels(rec), stripLabels(srv.data)), 'in sync: the server state, stored once');
  });

  await scenario('deferred edits (server never answered) survive a reload', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A0 = page('A0', srv, store); await A0.open();
    await waitFor('prime cache', () => A0._tripDataConfirmed); A0.discard();
    const B = makeClient('B', srv);
    B.edit(c => { place(c, 'w2').notes = 'from B'; });
    await settle([B], srv);
    const A1 = page('A1', srv, store, { offline: true }); await A1.open(); // cache-first, never confirmed
    A1.edit(c => c.WISHLIST.push({ id: 'deferredAdd', name: 'Bar' }));
    await waitFor('save deferred', () => A1._saveDeferred);
    assert(place(cacheOf(store), 'deferredAdd'), 'deferred edit is in the cache');
    A1.discard();
    const A2 = page('A2', srv, store, { offline: true }); await A2.open();
    A2.edit(c => { place(c, 'w1').name = 'Museum (A2)'; });   // a second deferred edit on top
    await waitFor('save deferred', () => A2._saveDeferred);
    A2.goOnline();
    await waitFor('reconnect', () => A2._tripDataConfirmed);
    await settle([A2, B], srv);
    assert(place(srv.data, 'deferredAdd'), 'first deferred edit lost');
    assert.strictEqual(place(srv.data, 'w1').name, 'Museum (A2)', 'second deferred edit lost');
    assert.strictEqual(place(srv.data, 'w2').notes, 'from B', 'collaborator edit reverted');
    converged([A2, B], srv);
  });

  await scenario('offline edit survives leaving to the dashboard and reopening', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A = page('A', srv, store); await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    A.goOffline();
    A.edit(c => { c.WISHLIST.push({ id: 'wNew', name: 'Offline find' }); place(c, 'w1').notes = 'go at 8am'; });
    await waitFor('offline save to fail', () => A.v('_saveFailCount') > 0);
    A.goToDashboard();                                    // flush fails offline, no retry after leaving
    await sleep(150);
    assert(!place(srv.data, 'wNew'));
    A.goOnline();
    await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    await settle([A], srv);
    assert(place(srv.data, 'wNew'), 'offline add lost');
    assert.strictEqual(place(srv.data, 'w1').notes, 'go at 8am', 'offline edit lost');
    converged([A], srv);
  });

  await scenario('no cache + slow server: generated days never overwrite the real days', async () => {
    for (const withEdit of [false, true]) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const A = page('A', srv, store, { getHangs: true, holdSnaps: true });
      await A.open();                                     // get() times out, openTrip builds days from the dates
      assert.strictEqual(A.DAYS.length, 2); assert.notStrictEqual(A.DAYS[0].id, 'd1');
      if (withEdit) A.edit(c => { c.DAYS[0].events.push({ id: 'ev_early', time: '12:00', title: 'Lunch' }); c.WISHLIST.push({ id: 'wEarly', name: 'Ramen' }); });
      await sleep(120);
      A.goOnline();                                       // the server's first snapshot arrives
      await waitFor('confirmed', () => A._tripDataConfirmed);
      await settle([A], srv);
      const d1 = srv.data.days[0], d2 = srv.data.days[1];
      assert.deepStrictEqual(srv.data.days.map(d => d.id), ['d1', 'd2'], 'server day ids kept');
      assert.deepStrictEqual([d1.theme, d1.color, d1.lodgingWishId, d2.theme, d2.color], ['Arrival', '#f97316', 'w2', 'Museums', '#10b981'], 'server day fields kept');
      if (withEdit) {
        assert.deepStrictEqual(d1.events.map(e => e.id), ['ev_1', 'ev_early'], 'early edit lands on the real day');
        assert(place(srv.data, 'wEarly'), 'early place lost');
      } else {
        assert.strictEqual(srv.commits, 0, 'nothing to save');
      }
      converged([A], srv);
    }
  });

  await scenario('two tabs on one trip, both offline: neither tab\'s edits are lost', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const X = page('X', srv, store), Y = page('Y', srv, store);
    await X.open(); await Y.open();
    await waitFor('both confirmed', () => X._tripDataConfirmed && Y._tripDataConfirmed);
    X.goOffline(); Y.goOffline();
    X.edit(c => { c.WISHLIST.push({ id: 'fromX', name: 'X' }, { id: 'tmpX', name: 'undone later' }); });
    await waitFor('X save to fail', () => X.v('_saveFailCount') > 0);
    Y.edit(c => { c.WISHLIST.push({ id: 'fromY', name: 'Y' }); place(c, 'w2').notes = 'Y note'; });
    await waitFor('Y save to fail', () => Y.v('_saveFailCount') > 0);
    Y.discard();                                         // tab Y closed
    const n = X.v('_saveFailCount');
    X.edit(c => { c.WISHLIST = c.WISHLIST.filter(w => w.id !== 'tmpX'); place(c, 'w1').name = 'Museum (X)'; });
    await waitFor('X save to fail again', () => X.v('_saveFailCount') > n);
    assert(!place(cacheOf(store), 'fromY'), 'X overwrote the shared copy (the case being tested)');
    X.discard();                                         // and X too, before the network came back
    const Z = page('Z', srv, store); await Z.open();
    await waitFor('confirmed', () => Z._tripDataConfirmed);
    await settle([Z], srv);
    ['fromX', 'fromY'].forEach(id => assert(place(srv.data, id), id + ' lost'));
    assert(!place(srv.data, 'tmpX'), 'a place removed before saving came back');
    assert.strictEqual(place(srv.data, 'w1').name, 'Museum (X)');
    assert.strictEqual(place(srv.data, 'w2').notes, 'Y note');
    converged([Z], srv);
    assert.deepStrictEqual(copyKeys(store), [], 'per-tab copies cleaned up');
  });

  await scenario('another account\'s unsaved edits are not replayed, but come back for their owner', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A1 = page('A1', srv, store); await A1.open();
    await waitFor('confirmed', () => A1._tripDataConfirmed);
    A1.goOffline();
    A1.edit(c => c.WISHLIST.push({ id: 'aOnly', name: 'A offline' }));
    await waitFor('offline save to fail', () => A1.v('_saveFailCount') > 0);
    A1.discard();
    const C = page('C', srv, store, { uid: 'uC' }); await C.open(); // someone else signs in on this browser
    assert(!place(C, 'aOnly'), 'other account\'s unsaved edit shown');
    await waitFor('confirmed', () => C._tripDataConfirmed);
    await settle([C], srv);
    assert(!place(srv.data, 'aOnly') && srv.commits === 0, 'other account\'s unsaved edit saved');
    C.goToDashboard(); C.discard();
    const A2 = page('A2', srv, store); await A2.open();   // the owner of that edit comes back
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2], srv);
    assert(place(srv.data, 'aOnly'), 'own unsaved edit lost after an account switch');
  });

  await scenario('a save that lands after leaving never reverts a later change on reopen', async () => {
    for (const how of ['left the trip', 'reloaded']) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const A = page('A', srv, store); await A.open();
      await waitFor('confirmed', () => A._tripDataConfirmed);
      const B = makeClient('B', srv);
      A.edit(c => { place(c, 'w2').notes = 'A note'; });
      let A2 = A;
      if (how === 'left the trip') { await sleep(20); A.goToDashboard(); await waitFor('flush lands', () => place(srv.data, 'w2').notes === 'A note'); await sleep(50); }
      else { await settle([A], srv); A.discard(); A2 = page('A2', srv, store); }
      B.edit(c => { place(c, 'w2').notes = 'B note'; });
      await settle([B], srv);
      const commits = srv.commits;
      await A2.open();
      await waitFor('confirmed', () => A2._tripDataConfirmed);
      await settle([A2, B], srv);
      assert.strictEqual(place(srv.data, 'w2').notes, 'B note', how + ': stale note came back');
      assert.strictEqual(srv.commits, commits, how + ': reopening saved something');
      converged([A2, B], srv);
    }
  });

  await scenario('an edit still waiting to save when signed out elsewhere comes back after signing in again', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A1 = page('A1', srv, store); await A1.open();
    await waitFor('confirmed', () => A1._tripDataConfirmed);
    A1.edit(c => c.WISHLIST.push({ id: 'lastSecond', name: 'typed just before sign-out' }));
    A1.currentUser = null; A1._leaveSignedOut();        // signed out in another tab: currentUser is cleared first
    await sleep(100);
    assert(!place(srv.data, 'lastSecond'));
    A1.discard();
    const A2 = page('A2', srv, store); await A2.open();  // same account signs back in
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2], srv);
    assert(place(srv.data, 'lastSecond'), 'edit lost across the sign-out');
  });

  await scenario('rewriting a closed trip\'s cache (days fix / date edit) keeps its unsaved edits', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A = page('A', srv, store); await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    A.goOffline();
    A.edit(c => c.WISHLIST.push({ id: 'pendingAdd', name: 'P' }));
    await waitFor('offline save to fail', () => A.v('_saveFailCount') > 0);
    A.goToDashboard(); A.goOnline();
    // What the dashboard days-fix / other-trip date edit does: a transaction on the server, then the cache.
    srv.data.days[1].theme = 'Fixed elsewhere'; srv.data.rev++; srv.version++; srv.notify();
    A._lsRebaseTripCache('trip1', clone(srv.data));
    const c = cacheOf(store);
    assert(place(c, 'pendingAdd') && c.base.rev === srv.data.rev && c.days[1].theme === 'Fixed elsewhere');
    await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    await settle([A], srv);
    assert(place(srv.data, 'pendingAdd'), 'unsaved edit lost by the cache rewrite');
    assert.strictEqual(srv.data.days[1].theme, 'Fixed elsewhere');
  });

  await scenario('a pre-v2 cache still opens (it is its own ancestor: the server wins)', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const old = datedTrip(); place(old, 'w1').name = 'stale name';
    store.set('travel-data-trip1', JSON.stringify({ days: old.days, wishlist: old.wishlist }));
    const A = page('A', srv, store); await A.open();
    assert.strictEqual(place(A, 'w1').name, 'stale name');
    await waitFor('confirmed', () => A._tripDataConfirmed);
    await settle([A], srv);
    assert.strictEqual(place(A, 'w1').name, 'Museum'); assert.strictEqual(srv.commits, 0);
    assert.strictEqual(cacheOf(store).v, 2, 'rewritten in the new format');
  });

  await scenario('viewers in different languages do not save on every reopen', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const B = makeClient('B', srv);                       // saves English day labels
    const A1 = page('A1', srv, store, { lang: 'ko' }); await A1.open();
    await waitFor('confirmed', () => A1._tripDataConfirmed);
    B.edit(c => { place(c, 'w1').notes = 'hi'; });
    await settle([A1, B], srv);                           // A1 relabels in Korean and caches that
    assert(/^ko:/.test(cacheOf(store).days[0].date) && !('base' in cacheOf(store)), 'labels alone don\'t count as unsaved edits');
    A1.discard();
    const commits = srv.commits;
    const A2 = page('A2', srv, store, { lang: 'ko' }); await A2.open();
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2, B], srv);
    assert.strictEqual(srv.commits, commits, 'label-only difference was saved');
  });

  await scenario('no cache + slow server: a place added while the data is still loading lands, even across a reload', async () => {
    for (const reload of [false, true]) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const A = page('A', srv, store, { getHangs: true, holdSnaps: true });
      const opening = A.open();
      await waitFor('data load waiting', () => A.DATA_REF && !A._tripDataConfirmed);
      assert.strictEqual(A.DAYS.length, 0, 'still loading');
      A.edit(c => c.WISHLIST.push({ id: 'duringLoad', name: 'added during the skeleton' }));
      await waitFor('save deferred', () => A._saveDeferred);
      assert(place(cacheOf(store), 'duringLoad') && deq(cacheOf(store).base, { days: [], wishlist: [] }), 'cached as an edit on an empty trip');
      let last = A;
      if (reload) { A.discard(); last = page('A2', srv, store); await last.open(); }
      else { await opening; A.goOnline(); }
      await waitFor('confirmed', () => last._tripDataConfirmed);
      await settle([last], srv);
      assert(place(srv.data, 'duringLoad'), (reload ? 'reload' : 'no reload') + ': place added while loading lost');
      const d1 = srv.data.days[0];
      assert.deepStrictEqual([d1.id, d1.theme, d1.color, d1.lodgingWishId], ['d1', 'Arrival', '#f97316', 'w2'], 'server day kept');
      converged([last], srv);
    }
  });

  await scenario('cached trip: a day a collaborator added and set up keeps its theme and color', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A1 = page('A1', srv, store); await A1.open();
    await waitFor('confirmed', () => A1._tripDataConfirmed);
    A1.goToDashboard(); A1.discard();
    // B extends the trip by a day and sets it up (B's client reconciled and saved day 3)
    srv.meta.endDate = '2026-10-03';
    srv.data.days.push({ id: 'd3', isoDate: '2026-10-03', date: 'en:2026-10-03', theme: 'Hike', color: '#123456', events: [] });
    srv.data.rev++; srv.version++;
    const commits = srv.commits;
    const A2 = page('A2', srv, store); await A2.open();  // cache-first: openTrip generates a blank day 3
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2], srv);
    const d3 = srv.data.days.find(d => d.isoDate === '2026-10-03');
    assert.deepStrictEqual([d3.id, d3.theme, d3.color], ['d3', 'Hike', '#123456'], 'collaborator\'s day overwritten');
    assert.strictEqual(srv.commits, commits, 'nothing to save');
    converged([A2], srv);
  });

  await scenario('a reloaded tab leaves a still-open tab\'s unsaved edits to that tab', async () => {
    for (const order of ['open tab lands first', 'both reconnect together']) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const X = page('X', srv, store), Y = page('Y', srv, store);
      await X.open(); await Y.open();
      await waitFor('both confirmed', () => X._tripDataConfirmed && Y._tripDataConfirmed);
      X.goOffline(); Y.goOffline();
      X.edit(c => { place(c, 'w2').notes = 'b'; });
      await waitFor('X save to fail', () => X.v('_saveFailCount') > 0);
      Y.discard();
      const Y2 = page('Y2', srv, store, { offline: true }); await Y2.open();    // the other tab is reloaded
      assert.strictEqual(place(Y2, 'w2').notes, 'orig', 'took over an edit a live tab still carries');
      const n = X.v('_saveFailCount');
      X.edit(c => { place(c, 'w2').notes = 'c'; });                             // the user's latest value, in tab X
      await waitFor('X save to fail again', () => X.v('_saveFailCount') > n);
      if (order === 'open tab lands first') { X.goOnline(); await waitFor('X lands', () => place(srv.data, 'w2').notes === 'c'); }
      X.goOnline(); Y2.goOnline();
      await waitFor('Y2 confirmed', () => Y2._tripDataConfirmed);
      await settle([X, Y2], srv);
      assert.strictEqual(place(srv.data, 'w2').notes, 'c', order + ': an older value came back');
      converged([X, Y2], srv);
      assert.deepStrictEqual(copyKeys(store), [], order + ': copies cleaned up');
    }
  });

  await scenario('a tab that left the trip hands its unsaved edits to the next tab that opens it', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const X = page('X', srv, store); await X.open();
    await waitFor('confirmed', () => X._tripDataConfirmed);
    X.goOffline();
    X.edit(c => c.WISHLIST.push({ id: 'leftBehind', name: 'L' }));
    await waitFor('offline save to fail', () => X.v('_saveFailCount') > 0);
    X.goToDashboard();                                    // X stays open, on the dashboard
    await sleep(100);
    const Y = page('Y', srv, store); await Y.open();
    await waitFor('confirmed', () => Y._tripDataConfirmed);
    await settle([Y], srv);
    assert(place(srv.data, 'leftBehind'), 'edit left behind by a tab that is still open was lost');
    assert.deepStrictEqual(copyKeys(store), []);
  });

  await scenario('same-page account switch keeps the first account\'s unsaved edits for it', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const P = page('P', srv, store); await P.open();     // signed in as uA
    await waitFor('confirmed', () => P._tripDataConfirmed);
    P.goOffline();
    P.edit(c => c.WISHLIST.push({ id: 'aOnly', name: 'A offline' }));
    await waitFor('offline save to fail', () => P.v('_saveFailCount') > 0);
    P.currentUser = null; P._leaveSignedOut();            // onAuthStateChanged(null)
    P.currentUser = { uid: 'uB' }; P.goOnline();          // uB signs in on the same page and opens the same trip
    await P.open();
    assert(!place(P, 'aOnly'), 'another account\'s unsaved edit shown');
    await waitFor('confirmed', () => P._tripDataConfirmed);
    await settle([P], srv);
    assert(!place(srv.data, 'aOnly'), 'another account\'s unsaved edit saved');
    assert(heldBy(store, 'aOnly').length > 0, 'uB\'s session wiped uA\'s unsaved edit');
    P.goToDashboard(); P.discard();
    const A2 = page('A2', srv, store); await A2.open();  // uA signs back in
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2], srv);
    assert(place(srv.data, 'aOnly'), 'uA\'s unsaved edit lost across the account switch');
  });

  await scenario('storage full after a save lands: reopening never replays it', async () => {
    for (const kind of ['field', 'deleted place']) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const A = page('A', srv, store); await A.open();
      await waitFor('confirmed', () => A._tripDataConfirmed);
      const B = makeClient('B', srv);
      const ls = A.localStorage, realSet = ls.setItem, marker = kind === 'field' ? 'A note' : 'aAdd';
      let seen = 0, full = false;
      const quota = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
      ls.setItem = (k, v) => { if (full) quota(); realSet(k, v); if (String(v).includes(marker) && ++seen >= 2) full = true; }; // doSave's pre-commit writes fit
      if (kind === 'field') A.edit(c => { place(c, 'w2').notes = 'A note'; });
      else A.edit(c => { c.WISHLIST.push({ id: 'aAdd', name: 'A add' }); });
      await settle([A], srv);
      if (kind === 'field') B.edit(c => { place(c, 'w2').notes = 'B note'; });
      else B.edit(c => { c.WISHLIST = c.WISHLIST.filter(w => w.id !== 'aAdd'); });
      await settle([A, B], srv);
      A.discard();
      const A2 = page('A2', srv, store);
      A2.localStorage.setItem = quota;                     // still full
      await A2.open();
      await waitFor('confirmed', () => A2._tripDataConfirmed);
      await settle([A2, B], srv);
      if (kind === 'field') assert.strictEqual(place(srv.data, 'w2').notes, 'B note', 'saved edit replayed over a later change');
      else assert(!place(srv.data, 'aAdd'), 'place deleted by a collaborator came back');
    }
  });

  // ---------- the save protocol: commit results, held snapshots, rev epochs, coalescing, contention ----------
  await scenario('undo while saving: like then unlike, add then delete during a commit, nothing lost', async () => {
    for (let i = 0; i < 10; i++) {
      const srv = makeServer(baseTrip()), A = makeClient('A', srv, { latency: [40, 80] }), B = makeClient('B', srv);
      A.edit(c => { c.WISHLIST[0].votes = { uA: { name: 'A' } }; c.WISHLIST.push({ id: 'oops', name: 'added by mistake' }); });
      await waitFor('commit in flight', () => A.v('_commitsInFlight') > 0);
      await sleep(15);
      A.edit(c => { delete c.WISHLIST[0].votes; });                                   // unlike
      // deleteWishItem: drop the place and save at once, bypassing the debounce
      A.v("WISHLIST = WISHLIST.filter(function(x){ return x.id !== 'oops'; }); clearTimeout(saveTimer); saveTimer = null; _commitTripData();");
      B.edit(c => c.WISHLIST.push({ id: 'fromB', name: 'B' }));
      await settle([A, B], srv);
      assert(!srv.data.wishlist[0].votes && !A.WISHLIST[0].votes, 'run ' + i + ': the unlike was lost');
      assert(!place(srv.data, 'oops') && !place(A, 'oops'), 'run ' + i + ': the deleted place came back');
      assert(place(srv.data, 'fromB'), 'run ' + i + ': collaborator add lost');
      converged([A, B], srv);
    }
  });

  await scenario('leaving the trip while a commit runs: an undo made just before still lands', async () => {
    for (const flushFails of [false, true]) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const A = page('A', srv, store, { latency: [40, 80] }); await A.open();
      await waitFor('confirmed', () => A._tripDataConfirmed);
      A.edit(c => { place(c, 'w1').votes = { uA: { name: 'A' } }; });            // like
      await waitFor('commit in flight', () => A.v('_commitsInFlight') > 0);
      await sleep(15);
      A.edit(c => { delete place(c, 'w1').votes; });                             // unlike
      if (flushFails) { // the flushed save (queued behind the like) fails: the edit must wait in the cache
        const real = A.db.runTransaction;
        A.db.runTransaction = function () { A.db.runTransaction = real; const e = new Error('offline'); e.code = 'unavailable'; return Promise.reject(e); };
      }
      A.goToDashboard();                                                         // flushes the unlike
      await waitFor('commits settled', () => A.v('_commitsInFlight') === 0);
      if (!flushFails) { assert(!place(srv.data, 'w1').votes, 'the unlike was lost'); continue; }
      assert(place(srv.data, 'w1').votes, 'setup: only the like landed');
      const A2 = page('A2', srv, store); await A2.open();
      await waitFor('confirmed', () => A2._tripDataConfirmed);
      await settle([A2], srv);
      assert(!place(srv.data, 'w1').votes, 'the unlike was lost from the cache');
      converged([A2], srv);
    }
  });

  await scenario('leave, reopen and edit while a slow commit runs: the undo made before leaving still lands', async () => {
    for (let i = 0; i < 4; i++) {
      const srv = makeServer(datedTrip(), META), store = new Map();
      const A = page('A', srv, store, { latency: [20, 40] }); await A.open();
      await waitFor('confirmed', () => A._tripDataConfirmed);
      // The like's commit is slow (contention backoff or a mobile network can stretch one to seconds): it's held
      // until the scenario has everything else queued behind it, rather than for a fixed time a busy machine can
      // outlast before the reopened trip gets to save.
      const real = A.db.runTransaction; let first = true, firstDone = false, release;
      const held = new Promise(r => { release = r; });
      A.db.runTransaction = function (fn) {
        if (!first) return real.call(this, fn);
        first = false;
        return held.then(() => real.call(this, fn)).finally(() => { firstDone = true; });
      };
      A.edit(c => { place(c, 'w1').votes = { uA: { name: 'A' } }; });            // like
      await waitFor('commit in flight', () => A.v('_commitsInFlight') > 0);
      await sleep(15);
      A.edit(c => { delete place(c, 'w1').votes; });                             // unlike
      A.goToDashboard();                                                         // its flush waits behind the like
      await A.open();                                                            // same trip, new DATA_REF
      await waitFor('confirmed again', () => A._tripDataConfirmed);
      A.edit(c => { place(c, 'w2').notes = 'unrelated'; });                      // a save on the new DATA_REF queues too
      await waitFor('like, flush and new save all waiting', () => A.v('_commitsInFlight') >= 3);
      assert(!firstDone, 'setup: the like landed before the reopened trip saved');
      await sleep(30); release();                                                // the like's commit goes ahead
      await settle([A], srv);
      assert(!place(srv.data, 'w1').votes && !place(A, 'w1').votes, 'run ' + i + ': the unlike was lost');
      assert.strictEqual(place(srv.data, 'w2').notes, 'unrelated');
      converged([A], srv);
    }
  });

  await scenario('echo of our own commit arrives before its reply: held, then recognised as stale', async () => {
    for (let i = 0; i < 8; i++) {
      // The commit reply takes 150ms after the write; the listener delivers within 5-40ms, so the echo (and B's
      // commit, made meanwhile) reach A while its commit is still running.
      const srv = makeServer(baseTrip()), A = makeClient('A', srv, { ackDelay: 150 }), B = makeClient('B', srv);
      A.edit(c => { c.WISHLIST[0].votes = { uA: { name: 'A' } }; c.WISHLIST.push({ id: 'oops', name: 'x' }); });
      await waitFor('A wrote', () => place(srv.data, 'oops'));
      assert(A.v('_commitsInFlight') > 0, 'reply should still be pending');
      A.edit(c => { delete c.WISHLIST[0].votes; c.WISHLIST = c.WISHLIST.filter(w => w.id !== 'oops'); });
      B.edit(c => { place(c, 'w2').notes = 'from B'; });
      await waitFor('echo held', () => A.v('_heldSnap') !== null);
      await settle([A, B], srv);
      assert(!srv.data.wishlist[0].votes && !place(srv.data, 'oops'), 'run ' + i + ': edits made while the reply was pending were lost');
      assert.strictEqual(place(srv.data, 'w2').notes, 'from B');
      assert.strictEqual(A.v('_heldSnap'), null);
      converged([A, B], srv);
    }
  });

  await scenario('a write without rev (older app / script) then newer edits: everyone converges', async () => {
    for (const how of ['coalesced listener', 'offline during the write']) {
      const init = baseTrip(); init.rev = 57; init.revEpoch = 'e57';
      const srv = makeServer(init);
      const A = makeClient('A', srv);
      const D = makeClient('D', srv, how === 'coalesced listener' ? { coalesce: true, latency: [60, 90] } : {});
      if (how !== 'coalesced listener') D.goOffline();   // a phone in a tunnel: on reconnect it sees only the newest state
      const old = clone(srv.data); delete old.rev; delete old.revEpoch; old.wishlist.push({ id: 'wo', name: 'from an old tab' });
      srv.blindSet(old);
      A.edit(c => c.WISHLIST.push({ id: 'wa', name: 'A place' }));
      await settle([A], srv);
      assert(srv.data.rev === 1 && srv.data.revEpoch && srv.data.revEpoch !== 'e57', how + ': count restarts in a new epoch');
      A.edit(c => { place(c, 'w1').notes = 'A: go early'; });
      await settle([A], srv);
      if (how !== 'coalesced listener') D.goOnline();
      await sleep(300);
      converged([A, D], srv);
      D.edit(c => { place(c, 'w2').notes = 'D: booked'; });
      await settle([A, D], srv);
      A.edit(c => { place(c, 'w2').notes = 'A: use the other hotel'; });
      await settle([A, D], srv);
      D.edit(c => c.WISHLIST.push({ id: 'wd2', name: 'D unrelated add' }));
      await settle([A, D], srv);
      assert.strictEqual(place(srv.data, 'w2').notes, 'A: use the other hotel', how + ': a later edit was reverted');
      ['wo', 'wa', 'wd2'].forEach(id => assert(place(srv.data, id), how + ': lost ' + id));
      assert.strictEqual(place(srv.data, 'w1').notes, 'A: go early');
      converged([A, D], srv);
    }
  });

  await scenario('a doc with rev but no epoch gets one on the next save, even with nothing to change', async () => {
    const init = baseTrip(); init.rev = 4;
    const srv = makeServer(init), A = makeClient('A', srv);
    A.edit(() => {});
    await settle([A], srv);
    assert(srv.data.rev === 5 && srv.data.revEpoch, 'epoch stamped');
    const commits = srv.commits;
    A.edit(() => {});
    await settle([A], srv);
    assert.strictEqual(srv.commits, commits, 'then nothing-to-write stays a no-op');
  });

  await scenario('chaos with coalesced snapshots and replies slower than the watch stream', async () => {
    const srv = makeServer(baseTrip());
    const cs = ['A', 'B', 'C', 'D'].map(n => makeClient(n, srv, { latency: [1, 100], coalesce: true, ackDelay: n === 'A' || n === 'C' ? 60 : 0 }));
    const kept = new Set(), mine = {};
    for (let i = 0; i < 100; i++) {
      const c = cs[Math.floor(Math.random() * cs.length)], id = c.name + i, op = Math.floor(Math.random() * 6);
      c.edit(x => {
        if (op === 0) { x.WISHLIST.push({ id, name: 'p' + id }); kept.add(id); }
        else if (op === 1) { // add and immediately undo: must not come back
          x.WISHLIST.push({ id: 'tmp' + id, name: 'undone' });
        }
        else if (op === 2) { x.WISHLIST[1]['mine_' + c.name] = id; mine['mine_' + c.name] = id; }
        else if (op === 3) { const d = x.DAYS[i % x.DAYS.length]; d.events.push({ id: 'ev_' + id, time: '08:00', title: id }); kept.add('ev_' + id); }
        else if (op === 4) { const w = x.WISHLIST[2]; w.votes = w.votes || {}; if (w.votes['u' + c.name]) delete w.votes['u' + c.name]; else w.votes['u' + c.name] = { name: c.name }; }
        else { x.WISHLIST[0].shared = id; }
      });
      if (op === 1) { await sleep(40 + Math.random() * 60); c.edit(x => { x.WISHLIST = x.WISHLIST.filter(w => w.id !== 'tmp' + id); }); }
      await sleep(Math.random() * 25);
    }
    await settle(cs, srv);
    converged(cs, srv);
    const ids = srv.data.wishlist.map(w => w.id), evIds = [].concat(...srv.data.days.map(d => d.events.map(e => e.id)));
    kept.forEach(k => assert(ids.includes(k) || evIds.includes(k), 'lost ' + k));
    assert(!ids.some(x => x.startsWith('tmp')), 'an undone add came back');
    Object.keys(mine).forEach(k => assert.strictEqual(srv.data.wishlist[1][k], mine[k], 'lost latest ' + k));
    console.log('   commits=' + srv.commits + ' retries=' + srv.conflicts);
  });

  await scenario('saves made while offline wait as one commit, not a growing queue', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv, { slowOffline: true });
    A.goOffline();
    let maxInFlight = 0, joined = 0;
    for (let i = 0; i < 25; i++) {
      A.edit(c => { place(c, 'w1').notes = 'offline ' + i; });
      await sleep(60);                                     // past the 50ms debounce: a save starts or joins every time
      const n = A.v('_commitsInFlight'); maxInFlight = Math.max(maxInFlight, n); if (n === 2) joined++;
    }
    assert(maxInFlight <= 2, 'commits piled up behind each other: ' + maxInFlight);
    assert(joined > 0, 'the scenario never had a commit waiting');
    A.goOnline(); A._retrySaveNow();
    await settle([A], srv);
    assert.strictEqual(place(srv.data, 'w1').notes, 'offline 24');
    converged([A], srv);
  });

  await scenario('back online: a save waiting out its retry backoff goes at once', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv);
    A.goOffline();
    A.edit(c => c.WISHLIST.push({ id: 'offlineAdd', name: 'x' }));
    await waitFor('3 failed saves', () => A.v('_saveFailCount') >= 3);   // the next retry is 20s (1s here) away
    A.goOnline(); A._retrySaveNow();                                     // window 'online'
    await waitFor('landed well before the backoff', () => place(srv.data, 'offlineAdd'), 500);
    await settle([A], srv);
    converged([A], srv);
  });

  await scenario('tab hidden right after an edit (then discarded): the edit is saved or kept for the next open', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A = page('A', srv, store); await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    A.edit(c => { place(c, 'w1').notes = 'typed, then switched apps'; });
    A._flushPendingSave();                                // visibilitychange -> hidden
    assert(!A.saveTimer, 'debounce still pending');
    A.discard();                                          // iOS drops the tab before the commit could land
    const A2 = page('A2', srv, store); await A2.open();
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2], srv);
    assert.strictEqual(place(srv.data, 'w1').notes, 'typed, then switched apps');
    converged([A2], srv);
  });

  await scenario('contention the SDK reports as failed-precondition is retried quietly', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv);
    srv.storm = 5;                                        // every attempt of one whole transaction finds the doc changed
    A.edit(c => c.WISHLIST.push({ id: 'wa', name: 'A' }));
    await settle([A], srv);
    assert.strictEqual(srv.exhausted, 1, 'the transaction should have given up once');
    assert(place(srv.data, 'wa'), 'retry never landed');
    assert.deepStrictEqual(A.toasts.filter(x => /saveFailed/.test(x)), [], 'error toast for plain contention');
  });

  await scenario('a trip near the 1 MiB document limit warns; over it, it says why and stops retrying', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv);
    let onScreen = null;                                  // the toast doSave can see (#saveToast's data-msg)
    A.showSaveToast = (m) => { A.toasts.push(m); onScreen = m; };
    A.document = { getElementById: (id) => (id !== 'saveToast' ? { style: {} } : onScreen ? { style: {}, dataset: { msg: onScreen } } : null) };
    srv.sizeLimit = 1024 * 1024;
    A.edit(c => { place(c, 'w1').notes = 'x'.repeat(950 * 1024); });
    await settle([A], srv);
    assert(place(srv.data, 'w1').notes.length === 950 * 1024 && A.toasts.includes('tripNearlyFull'), 'no warning near the limit');
    A.edit(c => { place(c, 'w3').notes = 'still big 1'; });
    await settle([A], srv);
    assert.strictEqual(onScreen, 'tripNearlyFull', 'a routine "Saved" replaced the size warning');
    onScreen = null;                                      // dismissed
    A.edit(c => { place(c, 'w3').notes = 'still big 2'; });
    await settle([A], srv);
    assert.strictEqual(onScreen, 'saved', 'a dismissed warning came straight back');
    A.v('_sizeWarned.at -= 6 * 60 * 1000');               // a few minutes later, still over
    A.edit(c => { place(c, 'w3').notes = 'still big 3'; });
    await settle([A], srv);
    assert.strictEqual(onScreen, 'tripNearlyFull', 'the warning never came back while the trip stayed near the limit');
    A.edit(c => { place(c, 'w2').notes = 'y'.repeat(200 * 1024); });
    await settle([A], srv);
    assert(A.toasts.includes('tripTooBig'), 'no clear message over the limit');
    assert(!A.saveTimer && !A.toasts.some(x => /saveFailed/.test(x)), 'kept retrying a save that can never land');
    A.edit(c => { place(c, 'w1').notes = 'trimmed'; });   // trimming lets it save again, with the earlier edit
    await settle([A], srv);
    assert.strictEqual(place(srv.data, 'w2').notes.length, 200 * 1024);
    assert.strictEqual(place(srv.data, 'w1').notes, 'trimmed');
    converged([A], srv);
  });

  // ---------- save paths outside the debounce: deleting a place, signing out ----------
  await scenario('deleting a place offline keeps retrying (the unload warning stays on) and lands once back online', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv);
    A.edit(c => { place(c, 'w1').notes = 'edited just before'; });   // a debounced save still pending goes with it
    A.goOffline();
    A.editingWishId = 'w3';
    await A.deleteWishItem();
    assert(!place(A, 'w3'), 'not deleted locally');
    assert(A.saveTimer, 'the failed delete is not being retried (nothing keeps beforeunload warning)');
    A.goOnline();
    await settle([A], srv);
    assert(!place(srv.data, 'w3'), 'the delete never landed');
    assert.strictEqual(place(srv.data, 'w1').notes, 'edited just before', 'the pending edit was dropped');
    converged([A], srv);
  });

  await scenario('deleting the last place of a trip without days lands (retries too); other empty saves are still refused', async () => {
    const trip = () => ({ days: [], wishlist: [{ id: 'w1', name: 'Only place' }] });
    const srv = makeServer(trip()), A = makeClient('A', srv);
    A.currentTripMeta = { type: 'hometown' };
    A.goOffline();
    A.editingWishId = 'w1';
    await A.deleteWishItem();
    assert(A.saveTimer, 'the forced save is not being retried');
    A.goOnline();
    await settle([A], srv);
    assert.deepStrictEqual(srv.data.wishlist, [], 'the last place came back');
    assert.strictEqual(A.v('_saveEmptyTrip'), null, 'still allowed to save empty after it landed');
    const srv2 = makeServer(trip()), B = makeClient('B', srv2);
    B.currentTripMeta = { type: 'hometown' };
    B.edit(c => { c.WISHLIST = []; });                   // emptied without a deliberate delete (a race): refused
    await settle([B], srv2);
    assert.strictEqual(srv2.data.wishlist.length, 1, 'the empty-state guard let an unforced save through');
  });

  await scenario('deleting the last place while an earlier save runs: that save landing keeps the delete retryable', async () => {
    const srv = makeServer({ days: [], wishlist: [{ id: 'w1', name: 'Only place' }] }), A = makeClient('A', srv);
    A.currentTripMeta = { type: 'hometown' };
    const orig = A.db.runTransaction; let calls = 0;
    A.db.runTransaction = function (fn) {
      calls++;
      if (calls === 1) return new Promise(r => setTimeout(r, 150)).then(() => orig(fn));  // still holds the place
      if (calls === 2) { const e = new Error('unavailable'); e.code = 'unavailable'; return Promise.reject(e); }
      return orig(fn);
    };
    A.edit(c => { place(c, 'w1').notes = 'edited'; });
    await waitFor('the earlier commit is running', () => calls === 1);
    A.editingWishId = 'w1';
    await A.deleteWishItem();                             // queued behind it, then fails once
    assert(A.saveTimer, 'the failed delete is not being retried');
    await settle([A], srv);
    assert.deepStrictEqual(srv.data.wishlist, [], 'the delete of the last place never landed (retry refused as empty)');
    assert.strictEqual(A.v('_saveEmptyTrip'), null, 'still allowed to save empty after the delete landed');
  });

  await scenario('an edit right before signing out still lands', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A = page('A', srv, store); await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    A.edit(c => { c.WISHLIST.push({ id: 'wLast', name: 'Added, then signed out' }); place(c, 'w1').notes = 'last note'; });
    await A.doSignOut();                                  // within the save debounce
    assert(A.authGone && A.currentTripId === null, 'did not sign out');
    assert(place(srv.data, 'wLast') && place(srv.data, 'w1').notes === 'last note', 'the flushed save was refused after signing out');
    assert(!A.toasts.some(x => /saveFailed/.test(x)), 'save reported as failed');
  });

  await scenario('signing out while a save hangs does not hang; the edit comes back with the next sign-in', async () => {
    const srv = makeServer(datedTrip(), META), store = new Map();
    const A = page('A', srv, store); await A.open();
    await waitFor('confirmed', () => A._tripDataConfirmed);
    A.db.runTransaction = () => new Promise(() => {});    // the commit never answers
    A.edit(c => { place(c, 'w1').notes = 'stuck in flight'; });
    const t0 = Date.now();
    await A.doSignOut();
    assert(A.authGone && Date.now() - t0 < 2000, 'sign-out waited on the stuck save');
    A.discard();
    const A2 = page('A2', srv, store); await A2.open();  // same account signs in again
    await waitFor('confirmed', () => A2._tripDataConfirmed);
    await settle([A2], srv);
    assert.strictEqual(place(srv.data, 'w1').notes, 'stuck in flight', 'the edit was lost');
    converged([A2], srv);
  });

  // ---------- places and their calendar events; day labels; background lookups ----------
  await scenario('two people schedule the same place at once (modal and calendar): one event, linked', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    schedule(A, 'w3', 'd1', 14 * 60, 'A note');
    calAdd(B, 'w3', 'd2', 16 * 60);
    await settle([A, B], srv);
    assert.strictEqual(evsWithId(srv.data, 'wl_ev_w3').length, 1, 'the place got two events');
    assert.strictEqual(place(srv.data, 'w3').calEventId, 'wl_ev_w3');
    linksOk(srv.data, 'server');
    converged([A, B], srv);
  });

  await scenario('moving a scheduled place to another day while a collaborator edits its event: one event, both changes', async () => {
    const srv = makeServer(scheduledTrip('wl_ev_legacy1')), A = makeClient('A', srv), B = makeClient('B', srv);
    schedule(A, 'w3', 'd2', 16 * 60);
    B.edit(c => { evsWithId(c, 'wl_ev_legacy1')[0][1].notes = 'tickets in email'; });
    await settle([A, B], srv);
    const evs = evsWithId(srv.data, 'wl_ev_legacy1');
    assert.deepStrictEqual(evs.map(([d, e]) => [d, e.time, e.notes]), [['d2', '16:00', 'tickets in email']], 'the move re-created the event');
    assert.strictEqual(srv.data.days.reduce((n, d) => n + d.events.length, 0), 2, 'a copy was left behind');
    linksOk(srv.data, 'server');
    converged([A, B], srv);
  });

  await scenario('schedule modal saves only what was changed in it: a collaborator\'s move and new time stay', async () => {
    const srv = makeServer(scheduledTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    openSched(A, 'w3');                                   // A opens the modal on w3's event (d1, 14:00-15:00)
    schedule(B, 'w3', 'd2', 10 * 60);                     // meanwhile B moves it to d2, 10:00-11:00
    await settle([A, B], srv);
    form(A, { schedNotes: 'bring cash' }); A.saveSchedule();   // A only typed a note
    await settle([A, B], srv);
    assert.deepStrictEqual(evsWithId(srv.data, 'wl_ev_w3').map(([d, e]) => [d, e.time, e.endTime, e.notes]),
      [['d2', '10:00', '11:00', 'bring cash']], 'the modal put back the day and time it opened with');
    linksOk(srv.data, 'server');
    // A new duration changes the end only, counted from the event's start as it is by then: a collaborator moved
    // it past the end the modal opened with, and the end must not land before the start.
    openSched(A, 'w3'); A.schedDurMin = 90; form(A, { schedNotes: 'bring cash' });
    B.edit(c => { const e = evsWithId(c, 'wl_ev_w3')[0][1]; e.time = '14:00'; e.endTime = '15:00'; });
    await settle([A, B], srv);
    A.saveSchedule();
    await settle([A, B], srv);
    assert.deepStrictEqual(evsWithId(srv.data, 'wl_ev_w3').map(([d, e]) => [d, e.time, e.endTime]), [['d2', '14:00', '15:30']]);
    // The same while the collaborator's new start is still on its way: both changes stay.
    openSched(A, 'w3'); A.schedDurMin = 60; form(A, { schedNotes: 'bring cash' });
    B.edit(c => { evsWithId(c, 'wl_ev_w3')[0][1].time = '13:30'; });
    A.saveSchedule();
    await settle([A, B], srv);
    assert.deepStrictEqual(evsWithId(srv.data, 'wl_ev_w3').map(([d, e]) => [d, e.time, e.endTime]), [['d2', '13:30', '15:00']]);
    // Saving with nothing changed writes nothing.
    const commits = srv.commits;
    openSched(A, 'w3'); form(A, { schedNotes: 'bring cash' }); A.saveSchedule();
    await settle([A, B], srv);
    assert.strictEqual(srv.commits, commits, 'saving an unchanged schedule wrote');
    converged([A, B], srv);
  });

  await scenario('schedule modal on a place that became a hotel meanwhile changes its event instead of adding one', async () => {
    const srv = makeServer(scheduledTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    openSched(A, 'w3');                                   // A opens the modal on w3's event (d1, 14:00-15:00)
    B.edit(c => { place(c, 'w3').category = 'hotel'; });   // meanwhile B makes it a hotel (one new event per save)
    await settle([A, B], srv);
    form(A, { schedNotes: 'late check-in' }); A.saveSchedule();   // A only typed a note
    await settle([A, B], srv);
    const placeEvs = [].concat(...srv.data.days.map(d => d.events.filter(e => e.id.indexOf('wl_ev_') === 0).map(e => [d.id, e.id, e.time, e.endTime, e.notes])));
    assert.deepStrictEqual(placeEvs, [['d1', 'wl_ev_w3', '14:00', '15:00', 'late check-in']], 'the note made a new event');
    assert.strictEqual(place(srv.data, 'w3').calEventId, 'wl_ev_w3');
    linksOk(srv.data, 'server');
    converged([A, B], srv);
  });

  await scenario('merging the flags of an unschedule and a reschedule keeps a linked place marked scheduled', async () => {
    const srv = makeServer(scheduledTrip('wl_ev_legacy1')), A = makeClient('A', srv), B = makeClient('B', srv);
    B.goOffline();
    B.schedWishId = 'w3'; B.removeFromCalendar(); schedule(B, 'w3', 'd2', 12 * 60);   // B takes it off and puts it back
    A.schedWishId = 'w3'; A.removeFromCalendar();          // A takes it off, and that lands first
    await settle([A], srv);
    B.goOnline();                                          // B's link wins the conflict; A's cleared flag must not
    await settle([A, B], srv);
    const w = place(srv.data, 'w3');
    assert(!w.calEventId || w.visited === true, 'a place linked to ' + w.calEventId + ' is not marked scheduled');
    linksOk(srv.data, 'server');
    converged([A, B], srv);
  });

  await scenario('adding from the calendar a place a collaborator just scheduled moves it instead of adding a twin', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    calAdd(B, 'w3', 'd1', 10 * 60, 'from B');
    await settle([A, B], srv);
    calAdd(A, 'w3', 'd2', 15 * 60);                       // A's list was drawn before B's save arrived
    await settle([A, B], srv);
    assert.deepStrictEqual(evsWithId(srv.data, 'wl_ev_w3').map(([d, e]) => [d, e.time, e.notes]), [['d2', '15:00', 'from B']]);
    linksOk(srv.data, 'server');
    converged([A, B], srv);
  });

  await scenario('removing a place from the schedule while a collaborator edits its event: the edit keeps it scheduled', async () => {
    const srv = makeServer(scheduledTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    A.schedWishId = 'w3'; A.removeFromCalendar();
    B.edit(c => { evsWithId(c, 'wl_ev_w3')[0][1].notes = 'booked 2pm'; });
    await settle([A, B], srv);
    assert.deepStrictEqual(evsWithId(srv.data, 'wl_ev_w3').map(([d, e]) => [d, e.notes]), [['d1', 'booked 2pm']]);
    const w = place(srv.data, 'w3');
    assert.deepStrictEqual([w.calDayId, w.calEventId, w.visited], ['d1', 'wl_ev_w3', true], 'the edited event was left without its place');
    converged([A, B], srv);
  });

  await scenario('deleting a scheduled place while a collaborator votes on it: the place stays, unscheduled', async () => {
    const srv = makeServer(scheduledTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    A.editingWishId = 'w3'; const deleting = A.deleteWishItem();
    B.edit(c => { place(c, 'w3').votes = { uB: { name: 'B' } }; });
    await deleting; await settle([A, B], srv);
    const w = place(srv.data, 'w3');
    assert(w && w.votes.uB, 'the vote was lost');
    assert.strictEqual(evsWithId(srv.data, 'wl_ev_w3').length, 0);
    assert.deepStrictEqual([w.calDayId, w.calEventId, w.visited], [null, null, false], 'the place links to a deleted event');
    converged([A, B], srv);
  });

  await scenario('a date change by a viewer in another language leaves no zombie days', async () => {
    for (const range of [['2026-10-01', '2026-10-04'], ['2026-10-11', '2026-10-15']]) {
      const isos = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
      const trip = { days: isos.map((iso, i) => ({ id: 'd' + (i + 1), isoDate: iso, date: 'en:' + iso, theme: '', events: [] })), wishlist: clone(baseTrip().wishlist) };
      trip.days[4].events.push({ id: 'ev_last', time: '10:00', title: 'Last-day brunch', notes: '' });
      const srv = makeServer(trip), A = makeClient('A', srv, { lang: 'ko' }), B = makeClient('B', srv, { lang: 'en' });
      A.refreshDayLabels();                               // what opening the trip does: Korean labels, nothing to save
      B.currentTripMeta = { startDate: range[0], endDate: range[1], type: 'trip' };
      B.reconcileDays(B.currentTripMeta); B.rerender();   // B edits the trip's dates
      await settle([A, B], srv);
      A.edit(c => { place(c, 'w1').votes = { uA: { name: 'A' } }; });  // then A saves something unrelated
      await settle([A, B], srv);
      const days = srv.data.days.map(d => d.isoDate);
      assert(days.length === 4 || days.length === 5, range + ': ' + days);
      assert(days.every(iso => iso >= range[0] && iso <= range[1]), range + ': days outside the trip came back: ' + days);
      assert(srv.data.days.every(d => /^en:/.test(d.date) || d.date.indexOf('/') > 0), range + ': stored labels flipped to the committer\'s language');
      assert.strictEqual(evsWithId(srv.data, 'ev_last').length, 1, range + ': the last day\'s event was lost');
      converged([A, B], srv);
    }
  });

  await scenario('two date changes at once: every open editor reconciles to the dates the server kept', async () => {
    const isos = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
    const trip = { days: isos.map((iso, i) => ({ id: 'd' + (i + 1), isoDate: iso, date: 'en:' + iso, theme: '', events: [] })), wishlist: clone(baseTrip().wishlist) };
    trip.days[1].events.push({ id: 'ev_02', time: '10:00', title: 'Museum', notes: '' });
    const first = { startDate: '2026-10-01', endDate: '2026-10-05', type: 'trip' };
    const srv = makeServer(trip, first), A = makeClient('A', srv), B = makeClient('B', srv), C = makeClient('C', srv);
    [A, B, C].forEach(c => { c.currentTripMeta = clone(first); c.v("_listenTripMeta('trip1', _openTripGen)"); });
    const mine = { A: { startDate: '2026-10-01', endDate: '2026-10-03', type: 'trip' }, B: { startDate: '2026-10-03', endDate: '2026-10-07', type: 'trip' } };
    // A and B save the trip form at the same time: each reconciles its own days; B's details write lands last.
    [A, B].forEach(c => { c.currentTripMeta = clone(mine[c.name]); c.reconcileDays(c.currentTripMeta); c.rerender(); });
    srv.setMeta(mine.A); srv.setMeta(mine.B);
    await sleep(40);
    await settle([A, B, C], srv);
    assert.deepStrictEqual(srv.data.days.map(d => d.isoDate), ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'], 'the days match neither date range');
    assert.strictEqual(evsWithId(srv.data, 'ev_02').length, 1, 'the event on a removed day was lost or duplicated');
    [A, B, C].forEach(c => assert.deepStrictEqual(c.currentTripMeta, mine.B, c.name + ' missed the final dates'));
    converged([A, B, C], srv);
  });

  await scenario('a place scheduled onto a day another person\'s date change removes lands on the last day, tagged and linked', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    schedule(A, 'w3', 'd2', 11 * 60);
    B.currentTripMeta = { startDate: '2026-10-01', endDate: '2026-10-01', type: 'trip' };
    B.reconcileDays(B.currentTripMeta); B.rerender();
    await settle([A, B], srv);
    assert.deepStrictEqual(srv.data.days.map(d => d.id), ['d1']);
    assert.deepStrictEqual(evsWithId(srv.data, 'wl_ev_w3').map(([d, e]) => [d, e.notes]), [['d1', '[originalDate 2026-10-02] ']]);
    linksOk(srv.data, 'server');
    converged([A, B], srv);
  });

  await scenario('a background geocode never brings back a place a collaborator deleted', async () => {
    const srv = makeServer(baseTrip());
    const A = makeClient('A', srv, { latency: [5, 15] }), B = makeClient('B', srv, { latency: [300, 400] });
    const look = lookups(B);
    B.geocodeWishItem(place(B, 'w3'));                    // B just opened the trip; teamLab has no coordinates
    A.edit(c => { c.WISHLIST = c.WISHLIST.filter(w => w.id !== 'w3'); });
    await waitFor('the delete to land', () => !place(srv.data, 'w3'));
    assert(place(B, 'w3'), 'setup: B already has the delete');
    look.answer('nominatim', [{ lat: '35.66', lon: '139.78' }]);
    await sleep(20);
    await settle([A, B], srv);
    assert(!place(srv.data, 'w3') && !place(A, 'w3'), 'the deleted place came back');
    converged([A, B], srv);
  });

  await scenario('lookups that answer after a merge swapped in fresh copies still land (place and event)', async () => {
    const t = baseTrip();
    t.days[0].events.push({ id: 'ev_g', time: '12:00', title: 'Lunch', mapsUrl: 'https://maps.app.goo.gl/abc', lat: null, lng: null });
    const srv = makeServer(t), A = makeClient('A', srv), B = makeClient('B', srv);
    const look = lookups(A);
    A.edit(c => {
      c.WISHLIST.push({ id: 'wNew', name: 'Ichiran', mapsUrl: 'https://maps.app.goo.gl/xyz' }, { id: 'wNew2', name: 'Afuri', mapsUrl: 'https://maps.app.goo.gl/def' });
      c._resolveWishCoords(place(c, 'wNew')); c._resolveWishCoords(place(c, 'wNew2'));
    });
    A.backfillEventCoords();
    const before = place(A, 'wNew');
    B.edit(c => c.WISHLIST.push({ id: 'wB', name: 'B place' }));
    await settle([A, B], srv);
    assert(place(A, 'wNew') !== before, 'setup: no merge replaced the place meanwhile');
    look.answer('def', { lat: 35.7, lng: 139.8 });
    look.answer('xyz', { url: 'https://www.google.com/maps/place/Ichiran' });   // expanded, but no coordinates
    await waitFor('the name lookup', () => look.count() === 2);
    B.edit(c => { place(c, 'wB').notes = 'again'; });   // and another merge while the name lookup runs
    await settle([A, B], srv);
    look.answer('nominatim', [{ lat: '35.1', lon: '139.7' }]);
    look.answer('abc', { lat: 35.5, lng: 139.5 });
    await sleep(20);
    await settle([A, B], srv);
    assert.deepStrictEqual([place(srv.data, 'wNew').lat, place(srv.data, 'wNew').lng], [35.1, 139.7], 'the place\'s coordinates (by name) were lost');
    assert.deepStrictEqual([place(srv.data, 'wNew2').lat, place(srv.data, 'wNew2').lng], [35.7, 139.8], 'the place\'s coordinates (from its link) were lost');
    const ev = evsWithId(srv.data, 'ev_g')[0][1];
    assert.deepStrictEqual([ev.lat, ev.lng], [35.5, 139.5], 'the event\'s coordinates were lost');
    converged([A, B], srv);
  });

  await scenario('lookups that answer after leaving the trip write nowhere, not even into a trip with the same ids', async () => {
    const t = datedTrip();
    t.wishlist.push({ id: 'wL', name: 'Ichiran', mapsUrl: 'https://maps.app.goo.gl/xyz' });
    t.days[1].events.push({ id: 'ev_g', time: '12:00', title: 'Lunch', mapsUrl: 'https://maps.app.goo.gl/abc' });
    const srv = makeServer(t, META), A = page('A', srv, new Map());
    const look = lookups(A);
    await A.open();                                       // opening starts the event's lookup
    await waitFor('confirmed', () => A._tripDataConfirmed);
    A.geocodeWishItem(place(A, 'w1')); A._resolveWishCoords(place(A, 'wL'));
    assert.strictEqual(look.count(), 3, 'setup: three lookups running');
    A.goToDashboard();
    look.answer('nominatim', [{ lat: '35.66', lon: '139.78' }]);   // answers on the dashboard
    await sleep(20);
    assert(!A.saveTimer, 'a lookup answered on the dashboard scheduled a save');
    await A.openTrip('trip2');                            // served from the same data here: the same place and event ids
    await waitFor('trip2 confirmed', () => A._tripDataConfirmed);
    await settle([A], srv);
    const commits = srv.commits;
    look.answer('xyz', { lat: 35.7, lng: 139.8 }); look.answer('abc', { lat: 35.5, lng: 139.5 });   // trip1's, the oldest
    await sleep(20);
    assert(!A.saveTimer, 'a lookup for the trip left behind scheduled a save in the open one');
    await settle([A], srv);
    assert.strictEqual(srv.commits, commits, 'a lookup for the trip left behind saved');
    [A, srv.data].forEach(d => {
      assert(place(d, 'w1').lat == null && place(d, 'wL').lat == null, 'a place took coordinates looked up for the trip left behind');
      assert(evsWithId(d, 'ev_g')[0][1].lat == null, 'an event took coordinates looked up for the trip left behind');
    });
  });

  await scenario('a place scheduled by a collaborator leaves the open calendar-add list; focus and a note stay in the dialog', async () => {
    const srv = makeServer(baseTrip()), A = makeClient('A', srv), B = makeClient('B', srv);
    const els = calAddDom(A), wids = () => [...els.calAddWishList.innerHTML.matchAll(/data-wid="([^"]*)"/g)].map(m => m[1]);
    const rerender = A.rerender; A.rerender = (noSave) => { rerender(noSave); A._refreshCalAddList(); };   // what rerender does
    A.calAddWishId = null; A.renderCalAddWishList();
    A.selectCalAddWish('w3');
    assert.strictEqual(A.document.activeElement.getAttribute('data-wid'), 'w3', 'setup: the pick has focus');
    schedule(B, 'w3', 'd2', 10 * 60);
    await settle([A, B], srv);
    assert.deepStrictEqual(wids(), ['w1', 'w2'], 'the list still offers a scheduled place');
    assert.strictEqual(A.calAddWishId, null, 'the pick was kept although it is no longer offered');
    assert.strictEqual(A.document.activeElement.getAttribute('data-wid'), 'w1', 'focus left the list');
    assert.strictEqual(els.calAddGone.textContent, 'calAddPickGone', 'nothing says why the pick went');
    A.selectCalAddWish('w2');                             // a hotel: still offered once scheduled
    assert.strictEqual(els.calAddGone.textContent, '', 'the note outlived a new pick');
    B.edit(c => { place(c, 'w1').name = 'Blue Bottle (Aoyama)'; Object.assign(place(c, 'w2'), { calDayId: 'd1', calEventId: 'wl_ev_h1' }); c.DAYS[0].events.push({ id: 'wl_ev_h1', title: 'Park Hyatt' }); });
    await settle([A, B], srv);
    assert(/Aoyama/.test(els.calAddWishList.innerHTML), 'the list did not follow a rename');
    assert.deepStrictEqual([A.calAddWishId, A.document.activeElement.getAttribute('data-wid'), els.calAddGone.textContent], ['w2', 'w2', ''], 'a pick still offered was dropped or lost focus');
    converged([A, B], srv);
  });

  console.log('\nALL MULTIPLAYER TESTS PASSED');
}
main().catch(e => { console.error('FAILED:', e.stack || e); process.exit(1); });
