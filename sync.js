/* Optional Google Drive sync. The data file lives in the app's private
   "appDataFolder" in the user's own Drive (scope drive.appdata), which this
   app can read and write but which never shows up in their Drive file list. */
(function (g) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const FILE_NAME = 'subscriptions.json';
  let token = null, tokenExpiry = 0, tokenClient = null, gisLoading = null;

  /** Merge two record lists: newest updatedAt wins per id; tombstones kept. */
  function merge(local, remote) {
    const map = new Map();
    [...local, ...remote].forEach(r => {
      if (!r || !r.id) return;
      const cur = map.get(r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.id, r);
    });
    return [...map.values()];
  }

  function loadGIS() {
    if (g.google && g.google.accounts && g.google.accounts.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in. Are you online?')); };
      document.head.appendChild(s);
    });
    return gisLoading;
  }

  function hasToken() { return token && Date.now() < tokenExpiry - 60000; }

  /** Must be called from a user gesture the first time (it may open a popup). */
  async function signIn(clientId, interactive) {
    if (!clientId) throw new Error('Add your Google OAuth client ID in Settings first.');
    await loadGIS();
    return new Promise((resolve, reject) => {
      tokenClient = g.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: resp => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          token = resp.access_token;
          tokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          resolve();
        },
        error_callback: err => reject(new Error((err && err.message) || 'Google sign-in was closed.')),
      });
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    });
  }

  function signOut() {
    if (token && g.google && g.google.accounts) g.google.accounts.oauth2.revoke(token, () => {});
    token = null; tokenExpiry = 0;
  }

  async function api(url, opts) {
    const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts && opts.headers) } });
    if (res.status === 401) { token = null; throw new Error('Google session expired. Tap Sync again.'); }
    if (!res.ok) throw new Error('Google Drive error ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res;
  }

  async function findFile() {
    const q = encodeURIComponent("name='" + FILE_NAME + "'");
    const res = await api('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,modifiedTime)&q=' + q);
    const j = await res.json();
    return j.files && j.files[0] ? j.files[0].id : null;
  }

  async function download(id) {
    const res = await api('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
    const j = await res.json();
    return Array.isArray(j.subs) ? j.subs : [];
  }

  async function upload(id, subs) {
    const body = JSON.stringify({ app: 'subscription-tracker', version: 1, savedAt: new Date().toISOString(), subs });
    if (id) {
      await api('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      });
      return id;
    }
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
    const res = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart,
    });
    return (await res.json()).id;
  }

  /** Pull, merge, save locally, push. Returns the merged list. */
  async function syncNow(localRaw) {
    if (!hasToken()) throw new Error('Not signed in to Google.');
    const id = await findFile();
    const remote = id ? await download(id) : [];
    const merged = merge(localRaw, remote);
    await upload(id, merged);
    return merged;
  }

  g.DriveSync = { merge, signIn, signOut, hasToken, syncNow };
})(self);
