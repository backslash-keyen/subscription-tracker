/* Service worker: offline app shell + background renewal reminders. */
const VERSION = 'v1.0.0';
const CACHE = 'subtracker-' + VERSION;
const SHELL = [
  './', './index.html', './styles.css', './app.js', './db.js', './sync.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/maskable-512.png',
];

importScripts('./db.js');

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('subtracker-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google APIs etc. go straight to network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});

/* Reminders: shown by the page when it opens, and here when the browser
   grants periodic background sync (installed app on Android Chrome). */
async function notifyDue() {
  const subs = await SubDB.all();
  const settings = await SubDB.getMeta('settings', {});
  if (settings.notifications === false) return;
  const notified = await SubDB.getMeta('notified', {});
  const due = SubDates.dueReminders(subs, settings.remindDays ?? 3);
  let changed = false;
  for (const d of due) {
    const key = d.sub.id + '@' + d.date;
    if (notified[key]) continue;
    const when = d.days === 0 ? 'today' : d.days === 1 ? 'tomorrow' : 'in ' + d.days + ' days';
    const price = typeof d.sub.price === 'number'
      ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: d.sub.currency || 'INR', maximumFractionDigits: 0 }).format(d.sub.price) + ' '
      : '';
    await self.registration.showNotification(d.sub.service + ' renews ' + when, {
      body: price + 'on ' + d.date + (d.sub.payment ? ' · ' + d.sub.payment : ''),
      tag: key,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
    });
    notified[key] = Date.now();
    changed = true;
  }
  if (changed) await SubDB.setMeta('notified', notified);
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'renewal-check') e.waitUntil(notifyDue());
});

self.addEventListener('message', e => {
  if (e.data === 'check-reminders') e.waitUntil(notifyDue());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./');
  })());
});
