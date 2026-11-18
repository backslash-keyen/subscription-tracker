(function () {
  'use strict';
  const APP_VERSION = '1.0.0';
  const D = self.SubDates;
  const $ = s => document.querySelector(s);

  const DEFAULT_SETTINGS = { remindDays: 3, currency: 'INR', clientId: '', driveConnected: false, notifications: true };
  let settings = { ...DEFAULT_SETTINGS };
  let subs = [];        // live (non-deleted) records
  let filter = 'all';
  let editingId = null;
  let deferredInstall = null;

  /* ---------------- formatting ---------------- */
  function money(n, cur) {
    if (typeof n !== 'number' || !isFinite(n)) return '–';
    const opts = { style: 'currency', currency: cur || settings.currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 };
    try { return new Intl.NumberFormat('en-IN', opts).format(n); } catch { return (cur || '') + ' ' + n.toFixed(2); }
  }
  function fmtDate(d) {
    if (!d) return '–';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function relDays(n) {
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    return 'in ' + n + ' days';
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }
  const STATUS_LABEL = { active: 'Active', trial: 'Trial', 'needs-details': 'Needs details', paused: 'Paused', cancelled: 'Cancelled' };

  function showStatus(msg, isError, ms) {
    const el = $('#status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = !msg;
    clearTimeout(showStatus.t);
    if (msg && ms !== 0) showStatus.t = setTimeout(() => { el.hidden = true; }, ms || 4000);
  }

  /* ---------------- render ---------------- */
  function missingFields(s) {
    const m = [];
    if (!s.plan) m.push('plan');
    if (typeof s.price !== 'number') m.push('price');
    if (!s.renewal) m.push('billing date');
    if (!s.email) m.push('account email');
    return m;
  }

  function cardHTML(s) {
    const next = D.nextRenewal(s);
    const days = next ? D.daysBetween(D.today(), next) : null;
    const window = Number.isFinite(s.remindDays) ? s.remindDays : settings.remindDays;
    const billing = ['active', 'trial'].includes(s.status);
    const cyc = D.CYCLES[s.cycle] || D.CYCLES.monthly;
    const missing = s.status === 'needs-details' ? missingFields(s) : [];
    const rows = [];
    if (s.email) rows.push(['Account', esc(s.email)]);
    if (s.payment) rows.push(['Paid with', esc(s.payment)]);
    if (s.category) rows.push(['Category', esc(s.category)]);
    if (s.notes) rows.push(['Notes', esc(s.notes)]);
    const cls = ['card'];
    if (s.status === 'needs-details') cls.push('needs');
    if (s.status === 'paused' || s.status === 'cancelled') cls.push('dim');
    return '<button class="' + cls.join(' ') + '" data-id="' + esc(s.id) + '" aria-label="Edit ' + esc(s.service) + '">' +
      '<div class="head"><div><div class="name">' + esc(s.service) + '</div>' +
      (s.plan ? '<div class="plan">' + esc(s.plan) + '</div>' : '') + '</div>' +
      '<span class="pill ' + esc(s.status) + '">' + esc(STATUS_LABEL[s.status] || s.status) + '</span></div>' +
      '<div class="price">' + (typeof s.price === 'number' ? money(s.price, s.currency) + ' <small>/ ' + cyc.label + '</small>' : '<small>Price unknown</small>') + '</div>' +
      (next ? '<div class="renew">' + (billing ? 'Renews ' : 'Billing date ') + fmtDate(next) +
        (billing ? ' · <span class="' + (days <= window ? 'soon' : '') + '">' + relDays(days) + '</span>' : '') + '</div>' : '') +
      (missing.length ? '<div class="missing">Missing: ' + missing.join(', ') + '</div>' : '') +
      (rows.length ? '<dl>' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>' : '') +
      '</button>';
  }

  function sortKey(s) {
    const order = { active: 0, trial: 1, 'needs-details': 2, paused: 3, cancelled: 4 };
    const next = D.nextRenewal(s);
    return [order[s.status] ?? 5, next ? next.getTime() : Infinity, s.service.toLowerCase()];
  }
  function cmp(a, b) {
    const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
    return 0;
  }

  function render() {
    const shown = subs.filter(s => {
      if (filter === 'all') return true;
      if (filter === 'active') return s.status === 'active' || s.status === 'trial';
      if (filter === 'inactive') return s.status === 'paused' || s.status === 'cancelled';
      return s.status === filter;
    }).sort(cmp);
    $('#cards').innerHTML = shown.map(cardHTML).join('');
    $('#empty').hidden = subs.length > 0;
    renderTotals();
    renderReminders();
  }

  function renderTotals() {
    const cur = settings.currency;
    let monthly = 0, counted = 0;
    const other = {}, unknown = [];
    subs.forEach(s => {
      if (s.status !== 'active') return;
      const m = D.monthlyCost(s);
      if (m === null) { unknown.push(s.service); return; }
      if ((s.currency || cur) === cur) { monthly += m; counted++; }
      else other[s.currency] = (other[s.currency] || 0) + m;
    });
    const otherTxt = Object.entries(other).map(([c, v]) => '+ ' + money(v, c)).join(' ');
    $('#tMonthly').textContent = money(Math.round(monthly * 100) / 100, cur);
    $('#tYearly').textContent = money(Math.round(monthly * 12 * 100) / 100, cur);
    const base = counted + ' active subscription' + (counted === 1 ? '' : 's');
    const unk = unknown.length ? ' · ' + unknown.length + ' without a price' : '';
    $('#tMonthlyNote').textContent = base + unk + (otherTxt ? ' · ' + otherTxt + '/mo' : '');
    $('#tYearlyNote').textContent = 'Monthly × 12' + (otherTxt ? ' · other currencies not included' : '');

    let best = null;
    subs.forEach(s => {
      if (!['active', 'trial'].includes(s.status)) return;
      const n = D.nextRenewal(s);
      if (n && (!best || n < best.date)) best = { s, date: n };
    });
    if (best) {
      const days = D.daysBetween(D.today(), best.date);
      $('#tNext').textContent = fmtDate(best.date);
      $('#tNextNote').textContent = best.s.service + (typeof best.s.price === 'number' ? ' · ' + money(best.s.price, best.s.currency) : '') + ' · ' + relDays(days);
    } else {
      $('#tNext').textContent = '–';
      $('#tNextNote').textContent = 'No upcoming billing dates';
    }
  }

  function renderReminders() {
    const due = D.dueReminders(subs, settings.remindDays);
    const el = $('#reminders');
    el.hidden = !due.length;
    el.innerHTML = due.map(d =>
      '<div class="reminder"><span><strong>' + esc(d.sub.service) + '</strong> renews ' +
      (typeof d.sub.price === 'number' ? 'for ' + esc(money(d.sub.price, d.sub.currency)) + ' ' : '') +
      'on ' + esc(fmtDate(D.parseISO(d.date))) + (d.sub.payment ? ' · ' + esc(d.sub.payment) : '') + '</span>' +
      '<span class="when">' + relDays(d.days) + '</span></div>').join('');
  }

  /* ---------------- data ---------------- */
  async function load() {
    settings = { ...DEFAULT_SETTINGS, ...(await SubDB.getMeta('settings', {})) };
    subs = await SubDB.all();
    render();
  }

  async function saveRecord(rec) {
    rec.updatedAt = Date.now();
    await SubDB.put(rec);
    subs = await SubDB.all();
    render();
    scheduleSync();
  }

  function normalize(r) {
    const price = r.price === '' || r.price === null || r.price === undefined ? null : Number(r.price);
    const rd = r.remindDays === '' || r.remindDays === null || r.remindDays === undefined ? null : Number(r.remindDays);
    return {
      id: String(r.id || uid()),
      service: String(r.service || 'Untitled').slice(0, 80),
      plan: String(r.plan || '').slice(0, 80),
      price: Number.isFinite(price) ? price : null,
      currency: String(r.currency || settings.currency || 'INR').toUpperCase().slice(0, 3),
      cycle: D.CYCLES[r.cycle] ? r.cycle : 'monthly',
      renewal: D.parseISO(r.renewal) ? r.renewal : '',
      status: STATUS_LABEL[r.status] ? r.status : 'active',
      category: String(r.category || '').slice(0, 40),
      email: String(r.email || '').slice(0, 120),
      payment: String(r.payment || '').slice(0, 60),
      link: /^https?:\/\//i.test(r.link || '') ? String(r.link).slice(0, 300) : '',
      notes: String(r.notes || '').slice(0, 500),
      remindDays: Number.isFinite(rd) ? rd : null,
      updatedAt: Number(r.updatedAt) || Date.now(),
      deleted: !!r.deleted,
    };
  }

  /** Reject anything that looks like card data in free-text fields. */
  function cardDataProblem(rec) {
    const fields = [rec.payment, rec.notes, rec.plan, rec.service, rec.category];
    for (const f of fields) {
      const digits = (f || '').replace(/[\s-]/g, '');
      if (/\d{12,19}/.test(digits)) return 'That looks like a full card number. Store only a label such as "HDFC Visa ending 4321".';
      if (/\bcvv\b|\bcvc\b|\bexp(iry)?\b\s*[:\-]?\s*\d/i.test(f || '')) return 'Please don\'t store CVV or expiry details here.';
    }
    return null;
  }

  /* ---------------- edit dialog ---------------- */
  const editDlg = $('#editDlg'), editForm = $('#editForm');

  function openEditor(id) {
    editingId = id || null;
    const s = id ? subs.find(x => x.id === id) : null;
    editForm.reset();
    $('#formError').hidden = true;
    $('#editTitle').textContent = s ? 'Edit ' + s.service : 'Add subscription';
    $('#deleteBtn').hidden = !s;
    const v = s || { status: 'active', currency: settings.currency, cycle: 'monthly' };
    ['service', 'plan', 'status', 'currency', 'cycle', 'renewal', 'category', 'email', 'payment', 'link', 'notes'].forEach(k => {
      editForm.elements[k].value = v[k] ?? '';
    });
    editForm.elements.price.value = typeof v.price === 'number' ? v.price : '';
    editForm.elements.remindDays.value = Number.isFinite(v.remindDays) ? String(v.remindDays) : '';
    if (!editForm.elements.currency.value) editForm.elements.currency.value = 'INR';
    editDlg.showModal();
    if (!s) editForm.elements.service.focus();
  }

  editForm.addEventListener('submit', async e => {
    e.preventDefault();
    const f = editForm.elements;
    const existing = editingId ? subs.find(x => x.id === editingId) : null;
    const rec = normalize({
      ...(existing || {}),
      id: editingId || uid(),
      service: f.service.value.trim(), plan: f.plan.value.trim(), status: f.status.value,
      price: f.price.value, currency: f.currency.value, cycle: f.cycle.value, renewal: f.renewal.value,
      remindDays: f.remindDays.value, category: f.category.value.trim(), email: f.email.value.trim(),
      payment: f.payment.value.trim(), link: f.link.value.trim(), notes: f.notes.value.trim(), deleted: false,
    });
    const problem = cardDataProblem(rec);
    if (problem) { $('#formError').textContent = problem; $('#formError').hidden = false; return; }
    await saveRecord(rec);
    editDlg.close();
    showStatus('Saved ' + rec.service + '.');
  });

  $('#deleteBtn').addEventListener('click', async () => {
    const s = subs.find(x => x.id === editingId);
    if (!s) return;
    if (!confirm('Delete ' + s.service + '?')) return;
    await saveRecord({ ...s, deleted: true });
    editDlg.close();
    showStatus('Deleted ' + s.service + '.');
  });

  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#addBtn').addEventListener('click', () => openEditor());
  $('#cards').addEventListener('click', e => {
    const c = e.target.closest('.card');
    if (c) openEditor(c.dataset.id);
  });
  $('#empty').addEventListener('click', e => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'add') openEditor();
    if (a.dataset.action === 'import') $('#importFile').click();
  });
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    filter = c.dataset.filter;
    document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    render();
  }));

  /* ---------------- settings ---------------- */
  const setDlg = $('#settingsDlg'), setForm = $('#settingsForm');

  function refreshDriveUI() {
    const connected = settings.driveConnected;
    $('#driveConnectBtn').textContent = connected ? 'Sync now' : 'Connect Google Drive';
    $('#driveDisconnectBtn').hidden = !connected;
    $('#syncBtn').hidden = !connected;
    const last = settings.lastSync ? new Date(settings.lastSync).toLocaleString('en-IN') : null;
    $('#driveState').textContent = connected ? ('Connected.' + (last ? ' Last synced ' + last + '.' : '')) : '';
    const perm = 'Notification' in self ? Notification.permission : 'unsupported';
    $('#notifyBtn').textContent = perm === 'granted' ? 'Notifications are on' : perm === 'denied' ? 'Notifications blocked in browser settings' : perm === 'unsupported' ? 'Notifications not supported here' : 'Turn on notifications';
    $('#notifyBtn').disabled = perm !== 'default';
  }

  $('#settingsBtn').addEventListener('click', () => {
    setForm.elements.remindDays.value = String(settings.remindDays);
    setForm.elements.currency.value = settings.currency;
    setForm.elements.clientId.value = settings.clientId || '';
    $('#appVersion').textContent = 'Version ' + APP_VERSION + '.';
    refreshDriveUI();
    setDlg.showModal();
  });

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    await SubDB.setMeta('settings', settings);
  }

  setForm.addEventListener('submit', async e => {
    e.preventDefault();
    await saveSettings({
      remindDays: Number(setForm.elements.remindDays.value),
      currency: setForm.elements.currency.value,
      clientId: setForm.elements.clientId.value.trim(),
    });
    setDlg.close();
    render();
    checkReminders();
  });

  /* ---------------- notifications ---------------- */
  $('#notifyBtn').addEventListener('click', async () => {
    if (!('Notification' in self)) return;
    const p = await Notification.requestPermission();
    refreshDriveUI();
    if (p === 'granted') {
      await registerPeriodic();
      checkReminders();
      showStatus('Notifications on. You\'ll get an alert when a renewal is coming up.');
    }
  });

  async function registerPeriodic() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!('periodicSync' in reg)) return;
      const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (st.state === 'granted') await reg.periodicSync.register('renewal-check', { minInterval: 12 * 60 * 60 * 1000 });
    } catch { /* not supported; in-app reminders still work */ }
  }

  async function checkReminders() {
    if (!('serviceWorker' in navigator) || !('Notification' in self) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage('check-reminders');
  }

  /* ---------------- calendar export ---------------- */
  function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m); }
  function icsDate(d) { return D.toISO(d).replace(/-/g, ''); }
  function fold(line) {
    const out = [];
    while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
    out.push(line);
    return out.join('\r\n');
  }

  function buildICS() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const rules = { weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', quarterly: 'FREQ=MONTHLY;INTERVAL=3', 'half-yearly': 'FREQ=MONTHLY;INTERVAL=6', yearly: 'FREQ=YEARLY' };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Subscription Tracker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Subscription renewals'];
    let count = 0;
    subs.forEach(s => {
      if (!['active', 'trial'].includes(s.status)) return;
      const next = D.nextRenewal(s);
      if (!next) return;
      count++;
      const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1);
      const remind = Number.isFinite(s.remindDays) ? s.remindDays : settings.remindDays;
      const price = typeof s.price === 'number' ? money(s.price, s.currency) : 'price unknown';
      const desc = [s.plan, price, s.payment && 'Paid with ' + s.payment, s.email && 'Account ' + s.email].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', 'UID:' + s.id + '@subscription-tracker', 'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + icsDate(next), 'DTEND;VALUE=DATE:' + icsDate(end),
        'RRULE:' + (rules[s.cycle] || rules.monthly),
        fold('SUMMARY:' + icsEscape(s.service + ' renews (' + price + ')')),
        fold('DESCRIPTION:' + icsEscape(desc)),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', fold('DESCRIPTION:' + icsEscape(s.service + ' renews soon')),
        // all-day events: alert at 9:00 local on the reminder day
        remind > 0 ? 'TRIGGER:-P' + (remind - 1) + 'DT15H' : 'TRIGGER:PT9H', 'END:VALARM',
        'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return { text: lines.join('\r\n') + '\r\n', count };
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  $('#icsBtn').addEventListener('click', () => {
    const { text, count } = buildICS();
    if (!count) { showStatus('No active subscriptions with a billing date to export.', true); return; }
    download('subscription-renewals.ics', text, 'text/calendar');
    showStatus('Calendar file saved with ' + count + ' renewal' + (count === 1 ? '' : 's') + '. Import it at calendar.google.com → Settings → Import.', false, 8000);
  });

  /* ---------------- backup ---------------- */
  $('#exportBtn').addEventListener('click', async () => {
    const raw = await SubDB.allRaw();
    const body = JSON.stringify({ app: 'subscription-tracker', version: 1, savedAt: new Date().toISOString(), subs: raw }, null, 2);
    download('subscriptions-backup-' + D.toISO(new Date()) + '.json', body, 'application/json');
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      const list = Array.isArray(j) ? j : j.subs;
      if (!Array.isArray(list)) throw new Error('No subscriptions found in that file.');
      const incoming = list.map(normalize);
      const bad = incoming.find(cardDataProblem);
      if (bad) throw new Error('"' + bad.service + '" contains what looks like card details. Remove them and try again.');
      const merged = DriveSync.merge(await SubDB.allRaw(), incoming);
      await SubDB.putMany(merged);
      subs = await SubDB.all();
      render();
      if (setDlg.open) setDlg.close();
      showStatus('Imported ' + incoming.filter(r => !r.deleted).length + ' subscription(s).');
      scheduleSync();
    } catch (err) {
      showStatus('Import failed: ' + err.message, true, 8000);
    }
  });

  /* ---------------- Drive sync ---------------- */
  let syncing = false, syncTimer = null;

  async function runSync(interactive) {
    if (syncing) return;
    if (!navigator.onLine) { showStatus('Offline. Changes are saved on this device and will sync when you\'re back online.'); return; }
    syncing = true;
    $('#syncBtn').disabled = true;
    $('#syncBtn').textContent = 'Syncing…';
    try {
      if (!DriveSync.hasToken()) {
        if (!interactive) return; // needs a tap to sign in again
        await DriveSync.signIn(settings.clientId, !settings.driveConnected);
      }
      const merged = await DriveSync.syncNow(await SubDB.allRaw());
      await SubDB.putMany(merged);
      subs = await SubDB.all();
      await saveSettings({ driveConnected: true, lastSync: Date.now() });
      render();
      refreshDriveUI();
      if (interactive) showStatus('Synced with Google Drive.');
    } catch (err) {
      showStatus('Sync failed: ' + err.message, true, 8000);
    } finally {
      syncing = false;
      $('#syncBtn').disabled = false;
      $('#syncBtn').textContent = 'Sync';
    }
  }

  function scheduleSync() {
    if (!settings.driveConnected || !DriveSync.hasToken()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => runSync(false), 1500);
  }

  $('#syncBtn').addEventListener('click', () => runSync(true));
  $('#driveConnectBtn').addEventListener('click', async () => {
    const id = setForm.elements.clientId.value.trim();
    if (id !== settings.clientId) await saveSettings({ clientId: id });
    await runSync(true);
  });
  $('#driveDisconnectBtn').addEventListener('click', async () => {
    DriveSync.signOut();
    await saveSettings({ driveConnected: false });
    refreshDriveUI();
    showStatus('Disconnected from Google Drive. Your data stays on this device.');
  });
  addEventListener('online', () => scheduleSync());

  /* ---------------- install + service worker ---------------- */
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('#installBtn').hidden = true;
  });
  addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      checkReminders();
      registerPeriodic();
    }).catch(err => console.warn('Service worker failed', err));
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(ok => { $('#persistNote').textContent = ok ? ' (protected from automatic clean-up)' : ''; });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { render(); checkReminders(); scheduleSync(); }
  });

  load().then(() => { refreshDriveUI(); checkReminders(); });
})();
