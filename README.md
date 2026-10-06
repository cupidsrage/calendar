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
- **Expense receipts** — attach up to three JPEG, PNG, WebP, or PDF receipts when logging an expense (5 MB per file). Both parents can download them; kid accounts cannot access them. Receipts are stored in the same SQLite database as the expense and removed when the expense is deleted, so the existing volume and database backups include them.
- **Push notifications** — install the app to your home screen and turn on notifications in settings to get the same alerts straight on your phone, even with the app closed. Per-device, so each phone opts in separately.
- **Emergency button (🚨)** — the one thing in the app that's allowed to be annoying. It skips approvals entirely: the other parent's phone alerts every 20 seconds for up to 10 minutes, and a full-screen alarm stays up on their side until they tap **I've seen it** — which you see happen. Optional one-line message, and a **False alarm** button if you mis-tapped. See [Emergency alerts](#emergency-alerts) for what it can and can't do.
- **Auto-sync** — polls every 25 seconds, so you both see changes without refreshing (every 5 seconds for emergency alerts).
- **Seasonal themes** — automatic Spring, Summer, Autumn, and Winter palettes, plus manual choices and the original look. Each device remembers its own preference.
- **Live Cabot weather** — current conditions and temperature for Cabot, Arkansas appear in the header. A 10-day forecast adds an icon, high/low temperatures, and matching sunshine, cloud, fog, rain, snow, or storm effects to each forecast day's calendar square. Weather is cached and never blocks the calendar.

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

## Push notification setup (Railway -> Variables)

The app works fine without this — you just won't get push notifications. To turn them on:

1. Generate a VAPID keypair once (locally, not on Railway): `npx web-push generate-vapid-keys`.
2. Add these variables in Railway:

| Variable | What it is |
|---|---|
| `VAPID_PUBLIC_KEY` | the public key from step 1 |
| `VAPID_PRIVATE_KEY` | the private key from step 1 — keep this secret |
| `VAPID_SUBJECT` | e.g. `mailto:you@yourdomain.com` (contact info required by the push spec) |
| `APP_URL` | e.g. `https://yourapp.up.railway.app` — opened when a notification is tapped |

3. Redeploy, then each parent opens **⚙ settings -> Push notifications -> Enable notifications on this device** on their phone.

This only works from an installed/home-screen app on iPhone (Safari, iOS 16.4+); on Android Chrome it works either installed or in the regular browser tab. Notifications are per-device — enable them separately on each phone. The log shows `[push] Web push ready` once the keys are set.

## Emergency alerts

The 🚨 in the header alerts the other parent immediately — no proposal, no approval, no waiting for them to open the app.

**What happens when you press it**

1. You confirm, and can add a one-line message ("Call me — at the ER with Ava").
2. Their phone gets a push notification that stays on screen, vibrates, and re-alerts **every 20 seconds for up to 10 minutes**.
3. An email goes out at the same time, as a backstop.
4. Whenever their app is actually open, it takes over the whole screen in red and plays a looping alarm tone.
5. None of it stops until they tap **I've seen it**. You then see "✓ *name* has seen your alert."

**Honest limits — worth knowing before you rely on it**

- A web app **cannot** hold a phone's ringer open the way an incoming call does, and it cannot override Do Not Disturb or the silent switch. There is no browser API for that on iOS or Android. "Keeps making noise until you look" is built out of *repeated* notifications, not one continuous ring.
- So it only gets loud if the other parent has **push notifications enabled on their phone** (⚙ settings → Push notifications) and the VAPID keys are configured. Without push, the alert still reaches them by email and still takes over the app the next time they open it — just not noisily.
- The looping alarm tone inside the app can't start until the phone has been touched at least once (every browser blocks audio before that). The alarm screen says so, and the sound starts on the first tap.
- After 10 minutes the repeat notifications stop, but the alarm screen stays up on their side until acknowledged. After 6 hours it's no longer treated as live.
- Repeats survive a redeploy or crash — the state is in the database, not in memory.
- **For a real life-or-death emergency, call 911 first.** This is for "I need you *now*", not a substitute for emergency services.

Only the parent being alerted can clear it; only the sender can call it off. Kid logins never see or send emergency alerts.

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

**Emergency** (sent once, immediately, and not subject to the notify toggle):
| Action | Who gets it |
|---|---|
| The 🚨 emergency button is pressed | the other parent |

Nothing goes to the person who took the action, and nothing goes to a parent with no email saved or notifications switched off.

## Run locally
```bash
npm install
npm start
# http://localhost:3000  (data in ./data/calendar.db)

# with email:
SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS=xxxx npm start

# with push:
VAPID_PUBLIC_KEY=xxx VAPID_PRIVATE_KEY=yyy npm start
```

## Notes
- SQLite via better-sqlite3 — zero config, lives on the volume.
- Push is fire-and-forget, same as email: if a send fails the calendar action still succeeds, and a dead subscription (uninstalled app, revoked permission) is quietly dropped so it stops being retried.
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

**Notifications:** email works everywhere once configured (see Email setup above). Push (see Push notification setup above) also works with the app closed on Android (installed or just a browser tab) and on iPhone once installed to the home screen (Safari, iOS 16.4+) — turn it on per-device in ⚙ settings.
