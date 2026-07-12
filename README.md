# Co-Parent Calendar

A shared custody calendar for two parents. Set a normal weekly schedule, switch individual days, add appointments for the kids, and ask the other parent to cover an appointment — they accept or decline from their inbox.

## Features
- **Two-parent sign-in** — each parent has a name, color, and PIN. One-time setup screen on first visit.
- **Custody calendar** — every day is tinted with whoever's day it is, based on your normal weekly pattern. One-off switches (dashed badge) don't touch the pattern.
- **Appointments** — title, kid, time, notes, and which parent is taking them.
- **Coverage requests** — "Ask ___ to cover" sends a request with an optional message. The other parent gets an inbox badge and can accept ("I'll cover it") or decline. Accepted appointments show a ⇄ handoff mark.
- **Auto-sync** — the page polls every 25 seconds, so you both see changes without refreshing.

## Deploy to Railway
1. Push this folder to a GitHub repo (or use `railway up` from the CLI).
2. In Railway: **New Project → Deploy from GitHub repo**. It auto-detects Node and runs `npm start`.
3. **Add a Volume** (important — without it your data wipes on every redeploy):
   - Right-click the service → **Attach Volume** (or Settings → Volumes).
   - Mount path: `/data` (any path works — the app reads `RAILWAY_VOLUME_MOUNT_PATH` automatically).
4. Settings → **Networking → Generate Domain** to get your public URL.
5. Open the URL, run the one-time setup (both parents' names, colors, PINs, and the kids), and send the link + her PIN to your ex.

## Run locally
```bash
npm install
npm start
# http://localhost:3000  (data saved to ./data/calendar.db)
```

## Notes
- Storage is SQLite via better-sqlite3 — zero config, lives entirely on the volume.
- Sessions persist until sign-out; the token is stored in each browser's localStorage.
- To start over completely, delete `calendar.db` on the volume (or the volume itself) and redeploy.
