/* Shared storage + date helpers. Plain script so both the page and the
   service worker can load it (importScripts). Exposes self.SubDB. */
(function (g) {
  'use strict';
  const DB_NAME = 'subscription-tracker';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('subs')) db.createObjectStore('subs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function reqP(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  const SubDB = {
    /** All records, including deleted tombstones. */
    allRaw() { return tx('subs', 'readonly', s => reqP(s.getAll())); },
    async all() { return (await SubDB.allRaw()).filter(r => !r.deleted); },
    put(rec) { return tx('subs', 'readwrite', s => { s.put(rec); }); },
    putMany(recs) { return tx('subs', 'readwrite', s => { recs.forEach(r => s.put(r)); }); },
    getMeta(key, fallback) {
      return tx('meta', 'readonly', s => reqP(s.get(key))).then(v => (v === undefined ? fallback : v));
    },
    setMeta(key, value) { return tx('meta', 'readwrite', s => { s.put(value, key); }); },
  };

  /* ---------- Dates (all dates are local YYYY-MM-DD strings) ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

  const CYCLES = {
    weekly: { label: 'week', months: 12 / 52, days: 7 },
    monthly: { label: 'month', months: 1 },
    quarterly: { label: 'quarter', months: 3 },
    'half-yearly': { label: '6 months', months: 6 },
    yearly: { label: 'year', months: 12 },
  };

  /** Date that is n cycles after anchor, keeping the anchor's day of month. */
  function addCycles(anchor, cycle, n) {
    const c = CYCLES[cycle] || CYCLES.monthly;
    if (c.days) return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + c.days * n);
    const total = anchor.getMonth() + c.months * n;
    const y = anchor.getFullYear() + Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(anchor.getDate(), last));
  }

  /** Next billing date on or after today, rolling a past date forward by its cycle. */
  function nextRenewal(sub, from) {
    const anchor = parseISO(sub.renewal);
    if (!anchor) return null;
    const t = from || today();
    let n = 0, d = anchor;
    while (d < t && n < 1000) { n++; d = addCycles(anchor, sub.cycle, n); }
    return d;
  }

  function monthlyCost(sub) {
    if (typeof sub.price !== 'number' || !isFinite(sub.price)) return null;
    const c = CYCLES[sub.cycle] || CYCLES.monthly;
    return sub.price / c.months;
  }

  /** Subscriptions whose reminder window has opened (and that bill). */
  function dueReminders(subs, defaultDays) {
    const t = today();
    const out = [];
    subs.forEach(s => {
      if (s.deleted || !['active', 'trial'].includes(s.status)) return;
      const next = nextRenewal(s, t);
      if (!next) return;
      const days = daysBetween(t, next);
      const window = Number.isFinite(s.remindDays) ? s.remindDays : defaultDays;
      if (days <= window) out.push({ sub: s, date: toISO(next), days });
    });
    return out.sort((a, b) => a.days - b.days);
  }

  g.SubDB = SubDB;
  g.SubDates = { toISO, parseISO, today, daysBetween, addCycles, nextRenewal, monthlyCost, dueReminders, CYCLES };
})(self);
