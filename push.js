const webpush = require('web-push');

// Configure in Railway → Variables. Generate a keypair once with:
//   npx web-push generate-vapid-keys
//   VAPID_PUBLIC_KEY   the public key (also handed to the browser to subscribe)
//   VAPID_PRIVATE_KEY  the private key (never exposed to the client)
//   VAPID_SUBJECT      e.g. "mailto:you@yourdomain.com" (contact info required by the push spec)
//   APP_URL            e.g. "https://yourapp.up.railway.app"  (opened when a notification is tapped)
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:calendar@example.com';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '') || '/';

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  console.log('[push] Web push ready');
} else {
  console.log('[push] Push disabled — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to turn it on.');
}

function fmtDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
function when(item) {
  return fmtDate(item.date) + (item.time ? ` at ${fmtTime(item.time)}` : '');
}
const money = cents => `$${(Math.abs(cents) / 100).toFixed(2)}`;

// Send one notification to every subscription for a parent. Returns the endpoints
// that turned out to be dead (unsubscribed/expired) so the caller can forget them.
async function sendToAll(subs, payload) {
  if (!enabled || !subs || !subs.length) return [];
  const body = JSON.stringify({ url: APP_URL, ...payload });
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
      else console.error(`[push] send failed (${e.statusCode || '?'}): ${e.message || e}`);
    }
  }));
  return dead;
}

// ---- Something needs YOUR approval before it's real. ----
function approvalNeeded({ subs, actor, kind, item, date, newOwner }) {
  let title, body;
  if (kind === 'swap_day') {
    title = `${actor} wants to swap ${fmtDate(date)}`;
    body = `Would become ${newOwner ? `${newOwner}'s day` : 'the normal rotation'} — needs your OK`;
  } else if (kind === 'edit') {
    title = `${actor} wants to change: ${item.title}`;
    body = `${when(item)} — needs your OK`;
  } else {
    title = kind === 'assign' ? `${actor} added an appointment for you` : `${actor} wants you to take this over`;
    body = `${item.title} — ${when(item)}`;
  }
  return sendToAll(subs, { title, body });
}

// ---- Your proposal was answered. ----
function proposalAnswered({ subs, actor, kind, accepted, item, date, newOwner }) {
  let title, body;
  if (kind === 'swap_day') {
    title = `${actor} ${accepted ? 'accepted' : 'declined'} the swap for ${fmtDate(date)}`;
    body = accepted ? `It's now ${newOwner || 'switched'}'s day` : 'The day stays as it was';
  } else if (kind === 'edit') {
    title = `${actor} ${accepted ? 'accepted' : 'declined'} your change`;
    body = item ? item.title : '';
  } else {
    title = `${actor} ${accepted ? 'accepted' : "can't take"}: ${item ? item.title : 'an appointment'}`;
    body = accepted ? 'Nothing more to do' : "It's unassigned again";
  }
  return sendToAll(subs, { title, body });
}

// ---- FYI only: something was added/changed that doesn't need approval. ----
function itemAdded({ subs, actor, item, owner, edited }) {
  const verb = edited ? 'updated' : 'added';
  const title = `${actor} ${verb}: ${item.title}`;
  const whenText = item.type === 'oncall'
    ? (item.end_date ? `${fmtDate(item.date)} – ${fmtDate(item.end_date)}` : fmtDate(item.date))
    : (item.type === 'birthday' ? `${fmtDate(item.date)} — repeats yearly` : when(item));
  const body = owner ? `${whenText} · ${owner}` : whenText;
  return sendToAll(subs, { title, body });
}

function itemDeleted({ subs, actor, item }) {
  return sendToAll(subs, { title: `${actor} removed: ${item.title}`, body: when(item) });
}

// ---- Expenses ----
function expenseLogged({ subs, actor, type, item, share_cents }) {
  const isReq = type === 'request';
  const title = isReq
    ? `${actor} is asking to split: ${item.description}`
    : `${actor} logged a shared cost: ${item.description}`;
  const body = isReq ? `Your share: ${money(share_cents)}` : `You owe ${money(share_cents)}`;
  return sendToAll(subs, { title, body });
}

function expenseAnswered({ subs, actor, action, item, share_cents }) {
  const map = {
    accept: [`${actor} accepted the split: ${item.description}`, `${actor} owes you ${money(share_cents)}`],
    decline: [`${actor} declined the split: ${item.description}`, 'Nothing is owed on it'],
    dispute: [`${actor} disputed: ${item.description}`, 'On hold until resolved'],
  };
  const [title, body] = map[action] || map.decline;
  return sendToAll(subs, { title, body });
}

function expenseSettled({ subs, actor, from_name, to_name, amount_cents, remaining_cents }) {
  const title = `${actor} recorded a payment: ${money(amount_cents)}`;
  const body = remaining_cents > 0
    ? `${from_name} paid ${to_name} — ${money(remaining_cents)} still owed`
    : `${from_name} paid ${to_name} — all square now`;
  return sendToAll(subs, { title, body });
}

module.exports = {
  enabled, publicKey: PUBLIC_KEY, sendToAll,
  approvalNeeded, proposalAnswered, itemAdded, itemDeleted,
  expenseLogged, expenseAnswered, expenseSettled
};
