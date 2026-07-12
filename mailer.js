const nodemailer = require('nodemailer');

// Configure in Railway → Variables. Works with Gmail, Resend, SendGrid, Mailgun, etc.
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS
//   MAIL_FROM   e.g. "Our Calendar <calendar@yourdomain.com>"  (falls back to SMTP_USER)
//   APP_URL     e.g. "https://yourapp.up.railway.app"  (used for the button link)
const HOST = process.env.SMTP_HOST;
const PORT = +(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.MAIL_FROM || (USER ? `Our Calendar <${USER}>` : null);
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const enabled = !!(HOST && USER && PASS);
let tx = null;
if (enabled) {
  tx = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,
    auth: { user: USER, pass: PASS }
  });
  tx.verify().then(
    () => console.log(`[mail] SMTP ready via ${HOST}`),
    e => console.warn(`[mail] SMTP not reachable: ${e.message}`)
  );
} else {
  console.log('[mail] Email disabled — set SMTP_HOST, SMTP_USER, SMTP_PASS to turn it on.');
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

function send(to, subject, html) {
  if (!enabled || !to) return;
  tx.sendMail({ from: FROM, to, subject, html })
    .then(() => console.log(`[mail] sent "${subject}" -> ${to}`))
    .catch(e => console.warn(`[mail] failed "${subject}" -> ${to}: ${e.message}`));
}

const LABEL = { appointment: 'appointment', event: 'event', birthday: 'birthday' };
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
  const subject = `${actor} ${verb}: ${item.title}`;
  send(to, subject, shell(
    `${esc(actor)} ${verb} ${item.type === 'birthday' ? 'a birthday' : `an ${LABEL[item.type] || 'item'}`}`,
    '#2F6D62',
    [
      ['What', esc(item.title)],
      ['When', esc(item.type === 'birthday' ? `${fmtDate(item.date)} \u2014 repeats yearly` : when(item))],
      kid && ['Kid', esc(kid)],
      owner && ['Who', `${esc(owner)} is taking them`],
      !owner && item.type !== 'birthday' && ['Who', 'Unassigned \u2014 nobody has claimed it'],
      item.notes && ['Notes', esc(item.notes)],
      ['Heads up', 'No approval needed \u2014 this is just so you know.']
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

module.exports = { enabled, approvalNeeded, proposalAnswered, itemAdded, itemDeleted };
