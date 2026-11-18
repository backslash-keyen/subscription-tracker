# Subscription Tracker

An offline-first, installable web app (PWA) for tracking subscriptions on PC and Android.

- Data is stored only on the device (IndexedDB). Nothing personal is in this repo.
- Works fully offline after the first load.
- Renewal reminders: in-app banner, optional notifications, and a calendar (.ics) export with alerts.
- Optional sync between devices through a private file in your own Google Drive (`drive.appdata` scope).
- Payment details are labels only. The app refuses full card numbers, CVV and expiry.

## Install
Open the GitHub Pages URL, then:
- **PC (Chrome/Edge):** click **Install** in the app bar, or the install icon in the address bar.
- **Android (Chrome):** menu ⋮ → **Add to Home screen / Install app**.

## Google Drive sync (optional)
1. Go to <https://console.cloud.google.com/>, create a project.
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **OAuth consent screen**: External, add your own Google account as a test user. Scope: `.../auth/drive.appdata`.
4. **Credentials → Create credentials → OAuth client ID**: type *Web application*.
   Authorized JavaScript origin: `https://<your-github-username>.github.io` (no path).
5. Copy the client ID into the app: ⚙ Settings → Google OAuth client ID → **Connect Google Drive**. Do the same on each device.

## Backup
⚙ Settings → Export / Import backup (JSON). Imports merge by id; the newest edit wins.
