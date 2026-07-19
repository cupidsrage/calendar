const { Resend } = require('resend');


// Configure in Railway → Variables. Sends over HTTPS (port 443), so it works on
// hosts that block outbound SMTP (like Railway).
//   RESEND_API_KEY   your Resend API key (starts with "re_")
//   MAIL_FROM        e.g. "Our Calendar <calendar@yourdomain.com>"
//                    must be an address on a domain you've verified in Resend,
//                    or use "onboarding@resend.dev" for sandbox testing
//   APP_URL          e.g. "https://yourapp.up.railway.app"  (used for the button link)
const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'Our Calendar <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const enabled = !!API_KEY;
let resend = null;
if (enabled) {
  resend = new Resend(API_KEY);
  console.log(`[mail] Resend ready — sending as ${FROM}`);
} else {
  console.log('[mail] Email disabled — set RESEND_API_KEY to turn it on.');
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

function shell(heading, accent, rows, cta) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#F6F7F4;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E1E4DC;border-radius:12px;overflow:hidden">
      <div style="height:5px;background:${accent}"></div>
      <div style="padding:22px 24px">
        <h1 style="margin:0 0 16px;font-size:19px;color:#21281F">${esc(heading)}</h1>
        <table style="width:100%;border-collapse:collapse;font-size:15px;color:#21281F">
          ${rows.filter(Boolean).map(([k, v]) => `
          <tr>
            <td style="padding:6px 0;color:#6B7265;width:110px;vertical-align:top">${esc(k)}</td>
            <td style="padding:6px 0;font-weight:600">${v}</td>
          </tr>`).join('')}
        </table>
        ${APP_URL ? `<a href="${APP_URL}" style="display:inline-block;margin-top:20px;background:#21281F;color:#F6F7F4;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">${esc(cta)}</a>` : ''}
        <p style="margin:20px 0 0;font-size:12px;color:#6B7265">Turn these off any time in the calendar's settings.</p>
      </div>
    </div>
  </div>`;
}

async function send(to, subject, html, attempt = 1) {
  if (!enabled || !to) return;
  try {
    const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) throw new Error(error.message || JSON.stringify(error));
    console.log(`[mail] sent "${subject}" -> ${to} (${data?.id || 'ok'})`);
  } catch (e) {
    const msg = e.message || String(e);
    // Retry only on transient errors (network blips, rate limits, 5xx).
    const transient = /timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|rate.?limit|429|5\d\d/i.test(msg);
    if (transient && attempt < 4) {
      const delay = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s
      console.warn(`[mail] retry ${attempt} for "${subject}" -> ${to} in ${delay}ms: ${msg}`);
      setTimeout(() => send(to, subject, html, attempt + 1), delay);
      return;
    }
    console.error(`[mail] GAVE UP "${subject}" -> ${to}: ${msg}`);
  }
}

const LABEL = { appointment: 'appointment', event: 'event', birthday: 'birthday', oncall: 'on-call period' };
const KIND_NOUN = {
  swap_day: 'day swap',
  assign: 'appointment',
  reassign: 'handoff',
  edit: 'change'
};

function when(item) {
  return fmtDate(item.date) + (item.time ? ` at ${fmtTime(item.time)}` : '');
}

// ---- Something needs YOUR approval before it's real. ----
function approvalNeeded({ to, actor, kind, item, prev, kid, message, date, newOwner }) {
  const A = esc(actor);
  let subject, heading, rows;

  if (kind === 'swap_day') {
    subject = `${actor} wants to swap ${fmtDate(date)} \u2014 needs your OK`;
    heading = `${A} is asking to swap a custody day`;
    rows = [
      ['Day', esc(fmtDate(date))],
      ['Would become', newOwner ? `${esc(newOwner)}'s day` : 'back to the normal rotation'],
      message && ['Message', `\u201C${esc(message)}\u201D`],
      ['Right now', 'Nothing has changed \u2014 the calendar stays as it is until you accept.']
    ];
  } else if (kind === 'edit') {
    subject = `${actor} changed something you agreed to: ${item.title} \u2014 needs your OK`;
    heading = `${A} wants to change something you already agreed to`;
    const changed = [];
    if (prev && prev.date !== item.date) changed.push(`Date: ${fmtDate(prev.date)} \u2192 <b>${fmtDate(item.date)}</b>`);
    if (prev && (prev.time || '') !== (item.time || '')) changed.push(`Time: ${prev.time ? fmtTime(prev.time) : 'none'} \u2192 <b>${item.time ? fmtTime(item.time) : 'none'}</b>`);
    if (prev && prev.title !== item.title) changed.push(`Title: ${esc(prev.title)} \u2192 <b>${esc(item.title)}</b>`);
    if (prev && (prev.notes || '') !== (item.notes || '')) changed.push(`Notes: <b>${esc(item.notes || 'removed')}</b>`);
    rows = [
      ['What', esc(item.title)],
      ['New details', esc(when(item))],
      changed.length && ['Changed', changed.join('<br>')],
      kid && ['Kid', esc(kid)],
      message && ['Message', `\u201C${esc(message)}\u201D`],
      ['Right now', 'The old version still stands until you accept the change.']
    ];
  } else {
    // assign | reassign
    subject = `${actor} is asking you to take: ${item.title} \u2014 needs your OK`;
    heading = kind === 'assign'
      ? `${A} added an appointment and put you on it`
      : `${A} is asking you to take this over`;
    rows = [
      ['What', esc(item.title)],
      ['When', esc(when(item))],
      kid && ['Kid', esc(kid)],
      message && ['Message', `\u201C${esc(message)}\u201D`],
      ['Right now', "It's on the calendar as unconfirmed. It isn't yours until you accept."]
    ];
  }

  send(to, subject, shell(heading, '#C0702A', rows, 'Accept or decline'));
}

// ---- Your proposal was answered. ----
function proposalAnswered({ to, actor, kind, accepted, item, date, newOwner }) {
  const A = esc(actor);
  const noun = KIND_NOUN[kind] || 'request';
  let subject, heading, rows;

  if (kind === 'swap_day') {
    subject = `${actor} ${accepted ? 'accepted' : 'declined'} the swap for ${fmtDate(date)}`;
    heading = accepted ? `${A} accepted the day swap` : `${A} declined the day swap`;
    rows = [
      ['Day', esc(fmtDate(date))],
      ['Result', accepted
        ? `It's now ${esc(newOwner || 'switched')} \u2014 the calendar is updated.`
        : 'The day stays as it was on the normal rotation.']
    ];
  } else if (kind === 'edit') {
    subject = `${actor} ${accepted ? 'accepted' : 'declined'} your change to ${item ? item.title : 'an appointment'}`;
    heading = accepted ? `${A} accepted your change` : `${A} declined your change`;
    rows = [
      item && ['What', esc(item.title)],
      item && ['When', esc(when(item))],
      ['Result', accepted ? 'The change is live and still theirs.' : 'The original version stands \u2014 nothing changed.']
    ];
  } else {
    subject = `${actor} ${accepted ? 'accepted' : "can't take"}: ${item ? item.title : 'an appointment'}`;
    heading = accepted ? `${A} accepted` : `${A} can't take this one`;
    rows = [
      item && ['What', esc(item.title)],
      item && ['When', esc(when(item))],
      ['Result', accepted
        ? `${A} is taking them \u2014 nothing more to do.`
        : "Nobody's on it now. It's on the calendar as unassigned until one of you claims it."]
    ];
  }

  send(to, subject, shell(heading, accepted ? '#2F6D62' : '#A33B2E', rows, 'Open the calendar'));
}

// ---- FYI only: something was added/changed that doesn't need your approval. ----
function itemAdded({ to, actor, item, kid, owner, edited }) {
  const verb = edited ? 'updated' : 'added';
  const isOncall = item.type === 'oncall';
  const subject = isOncall
    ? `${actor} ${verb} an on-call period: ${item.title}`
    : `${actor} ${verb}: ${item.title}`;
  const whenText = isOncall
    ? (item.end_date ? `${fmtDate(item.date)} \u2013 ${fmtDate(item.end_date)}` : fmtDate(item.date))
    : (item.type === 'birthday' ? `${fmtDate(item.date)} \u2014 repeats yearly` : when(item));
  send(to, subject, shell(
    `${esc(actor)} ${verb} ${item.type === 'birthday' ? 'a birthday' : `an ${LABEL[item.type] || 'item'}`}`,
    isOncall ? '#4A5FA5' : '#2F6D62',
    [
      ['What', esc(item.title)],
      ['When', esc(whenText)],
      kid && ['Kid', esc(kid)],
      isOncall && owner && ['Who', `${esc(owner)} is on call`],
      !isOncall && owner && ['Who', `${esc(owner)} is taking them`],
      !owner && item.type !== 'birthday' && !isOncall && ['Who', 'Unassigned \u2014 nobody has claimed it'],
      item.notes && ['Notes', esc(item.notes)],
      ['Heads up', isOncall
        ? 'Just so you know they may get pulled away \u2014 no approval needed.'
        : 'No approval needed \u2014 this is just so you know.']
    ],
    'Open the calendar'
  ));
}

function itemDeleted({ to, actor, item }) {
  send(to, `${actor} removed: ${item.title}`, shell(
    `${esc(actor)} removed something from the calendar`,
    '#6B7265',
    [
      ['What', esc(item.title)],
      ['When', esc(when(item))]
    ],
    'Open the calendar'
  ));
}

// ---- Expenses (shared-cost splitting) ----
const money = cents => `$${(Math.abs(cents) / 100).toFixed(2)}`;

// Someone logged an expense involving you.
function expenseLogged({ to, actor, type, item, kid, share_cents }) {
  const A = esc(actor);
  const isReq = type === 'request';
  const subject = isReq
    ? `${actor} is asking to split: ${item.description} (${money(share_cents)})`
    : `${actor} logged a shared cost: ${item.description} (you owe ${money(share_cents)})`;
  const heading = isReq
    ? `${A} is asking you to split a cost`
    : `${A} logged a shared cost`;
  const rows = [
    ['What', esc(item.description)],
    ['Total', money(item.amount_cents)],
    ['Your share', `${money(share_cents)}${item.split_pct !== 50 ? ` (${item.split_pct}%)` : ''}`],
    kid && ['Kid', esc(kid)],
    ['When', esc(fmtDate(item.date))],
    ['Right now', isReq
      ? "It won't count until you accept the split. You can accept or decline."
      : "It's counted as owed. If it looks wrong, you can dispute it."]
  ];
  send(to, subject, shell(heading, isReq ? '#C0702A' : '#2F6D62', rows,
    isReq ? 'Accept or decline' : 'Open expenses'));
}

// The other parent answered your request, or disputed your necessity.
function expenseAnswered({ to, actor, action, next, item, share_cents }) {
  const A = esc(actor);
  const map = {
    accept:  [`${actor} accepted the split: ${item.description}`, `${A} accepted the split`,
              `${A} owes you ${money(share_cents)}. It's in the running balance.`, '#2F6D62'],
    decline: [`${actor} declined the split: ${item.description}`, `${A} declined the split`,
              "It's off the tally \u2014 nothing is owed on it.", '#A33B2E'],
    dispute: [`${actor} disputed: ${item.description}`, `${A} disputed this cost`,
              "It's on hold and out of the balance until you resolve it \u2014 withdraw it or put it back.", '#C0702A'],
  };
  const [subject, heading, result, accent] = map[action] || map.decline;
  send(to, subject, shell(heading, accent, [
    ['What', esc(item.description)],
    ['Total', money(item.amount_cents)],
    ['Share', money(share_cents)],
    ['Result', result]
  ], 'Open expenses'));
}

// A payment was recorded (full or partial).
function expenseSettled({ to, actor, from_name, to_name, amount_cents, remaining_cents, note }) {
  const paidLine = `${esc(from_name)} paid ${esc(to_name)} ${money(amount_cents)}`;
  const remainLine = remaining_cents > 0
    ? `${money(remaining_cents)} still owed after this.`
    : 'That clears the balance — all square now.';
  send(to, `${actor} recorded a payment: ${money(amount_cents)}`, shell(
    `${esc(actor)} recorded a payment`, '#2F6D62',
    [
      ['Payment', paidLine],
      ['Balance', remainLine],
      note && ['Note', `\u201C${esc(note)}\u201D`]
    ],
    'Open expenses'
  ));
}

module.exports = { enabled, approvalNeeded, proposalAnswered, itemAdded, itemDeleted,
                   expenseLogged, expenseAnswered, expenseSettled };
