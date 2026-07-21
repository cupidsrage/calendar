# Co-Parent Calendar

A shared custody calendar for two parents. Week-on/week-off schedule, appointments, events, birthdays, and coverage requests — with email notifications.

## Features
- **Two-parent sign-in** — each parent has a name, color, email, and PIN. One-time setup on first visit.
- **Custody calendar** — week-on/week-off rotation. Pick the exchange day and whose week it is now; it alternates automatically forever. One-off switches (dashed badge) don't affect the rotation.
- **Appointments, events & birthdays** — appointments have a responsible parent (and can be swapped); events can belong to one parent or both; birthdays repeat yearly and show the kid's age.
- **Nothing lands on the other person without their OK.** Anything that puts an obligation on them is a *proposal* — it shows as pending (⏳) and doesn't take effect until they accept:
  - assigning them an appointment
  - handing them one you're already on
  - proposing a custody day swap
  - changing an appointment they already agreed to (re-approval required)

  Anything that only affects yourself — taking an appointment, adding an unassigned event, adding a birthday — is immediate. Declining an appointment leaves it **unassigned** until one of you claims it; declining a swap leaves the day as it was.
- **Email notifications** — you get an email when the other parent adds something, asks you to cover, answers your request, or switches a custody day. Each parent can turn theirs off in settings.
- **Auto-sync** — polls every 25 seconds, so you both see changes without refreshing.
- **Seasonal themes** — automatic Spring, Summer, Autumn, and Winter palettes, plus manual choices and the original look. Each device remembers its own preference.

## Deploy to Railway
1. Push this folder to a GitHub repo (or `railway up` from the CLI).
2. Railway: **New Project -> Deploy from GitHub repo**. Auto-detects Node, runs `npm start`.
3. **Attach a Volume** (important — without it data wipes on every redeploy). Right-click the service -> **Attach Volume**, mount path `/data`. The app reads `RAILWAY_VOLUME_MOUNT_PATH` automatically.
4. Settings -> **Networking -> Generate Domain** for your public URL.
5. Add the email variables below, then open the URL and run the one-time setup.

## Email setup (Railway -> Variables)

The app works fine without this — you just won't get emails. To turn them on:

| Variable | What it is |
|---|---|
| `SMTP_HOST` | your mail provider's SMTP server |
| `SMTP_PORT` | `587` (default) or `465` |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password or API key |
| `MAIL_FROM` | e.g. `Our Calendar <calendar@yourdomain.com>` (optional, defaults to `SMTP_USER`) |
| `APP_URL` | e.g. `https://yourapp.up.railway.app` — makes the button in each email link back to the calendar |

### Option A — Gmail (fastest, free)
1. Turn on 2-Step Verification on the Google account you'll send from.
2. Google Account -> Security -> **App passwords**, create one for "Mail". You get a 16-character password.
3. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=youraddress@gmail.com`, `SMTP_PASS=` the app password.

Gmail rewrites the From address to your own Gmail, so emails look like they came from you. Fine for two people.

### Option B — Resend (better deliverability, free tier)
1. Sign up at resend.com, verify a domain.
2. Create an API key.
3. Set `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`, `SMTP_USER=resend`, `SMTP_PASS=` your API key, `MAIL_FROM=Our Calendar <calendar@yourdomain.com>`.

SendGrid, Mailgun, and Postmark work the same way — plug in their host/user/pass.

After redeploying, the log shows `[mail] SMTP ready via <host>` if it connected. Wrong credentials show `[mail] SMTP not reachable` — the calendar keeps working, it just won't send.

## What triggers an email
**Needs your OK** (nothing has changed yet):
| Action | Who gets it |
|---|---|
| You're assigned an appointment | the parent being assigned |
| An appointment is handed to you | the parent being asked |
| A custody day swap is proposed | the other parent |
| Something you agreed to was changed | the parent who agreed |

**Answered / heads-up** (no action needed):
| Action | Who gets it |
|---|---|
| Your proposal was accepted or declined | the parent who proposed |
| Something was added that doesn't need approval | the other parent |
| Something was deleted | the other parent |

Nothing goes to the person who took the action, and nothing goes to a parent with no email saved or notifications switched off.

## Run locally
```bash
npm install
npm start
# http://localhost:3000  (data in ./data/calendar.db)

# with email:
SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS=xxxx npm start
```

## Notes
- SQLite via better-sqlite3 — zero config, lives on the volume.
- Sessions persist until sign-out; token stored in each browser's localStorage.
- Email is fire-and-forget: if the mail server hiccups, the calendar action still succeeds and the failure is logged.
- To start over, delete `calendar.db` on the volume and redeploy.

## Install on Android (and iPhone)

The app is a PWA — it installs to the home screen straight from the browser. No Play Store, no APK, no $25 fee.

**Android (Chrome):**
1. Open your Railway URL in Chrome.
2. Wait a couple of seconds — a black "Add to your home screen" bar slides up. Tap **Install**.
3. If you dismissed it, use the ⋮ menu → **Install app** (or **Add to Home screen**).

**iPhone (Safari):** Share button → **Add to Home Screen**. (iOS only allows this from Safari, not Chrome.)

Once installed it opens fullscreen with its own icon and no browser bar. It refreshes the moment you open it or unlock your phone, so you never see stale data.

**Redeploys reach both phones automatically.** The service worker is served with no-cache and self-updates, so pushing to Railway updates the installed app on next open — no reinstall needed.

**Offline:** the app shell is cached, so it opens without a connection and shows a red "You're offline" bar. Calendar data is never cached (a stale custody day is worse than none), and any change you try to make while offline tells you it didn't save rather than pretending it did.

**Notifications** are email-only (see Email setup above). Android web push is unreliable when the browser is closed, so email is the dependable channel for "she needs to approve this."
