const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mail = require('./mailer');

// ---------- storage ----------
// On Railway, attach a Volume and it persists at RAILWAY_VOLUME_MOUNT_PATH.
// Locally it falls back to ./data
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'calendar.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS parents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  email TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  parent_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  anchor_date TEXT NOT NULL,        -- YYYY-MM-DD, first day of a custody week
  anchor_parent INTEGER NOT NULL    -- whose week starts on anchor_date; alternates every 7 days
);
CREATE TABLE IF NOT EXISTS overrides (
  date TEXT PRIMARY KEY,            -- YYYY-MM-DD; only ACCEPTED swaps land here
  parent_id INTEGER
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'appointment',  -- appointment | event | birthday
  title TEXT NOT NULL,
  kid_id INTEGER,
  date TEXT NOT NULL,               -- YYYY-MM-DD (birthdays recur yearly on MM-DD)
  time TEXT,                        -- HH:MM (optional)
  notes TEXT,
  parent_id INTEGER,                -- who is taking them (NULL = unassigned/both)
  confirmed INTEGER NOT NULL DEFAULT 1,  -- 0 while the assigned parent hasn't agreed yet
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- swap_day | assign | reassign | edit
  appointment_id INTEGER,           -- for assign/reassign/edit
  date TEXT,                        -- for swap_day
  to_parent_on_date INTEGER,        -- for swap_day: proposed owner of the day
  payload TEXT,                     -- for edit: JSON of the proposed new values
  from_parent INTEGER NOT NULL,
  to_parent INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | declined | cancelled
  created_at TEXT NOT NULL,
  responded_at TEXT
);
`);

// Migrate databases created by the earlier weekday-pattern version.
const parentCols = db.prepare("PRAGMA table_info(parents)").all();
if (parentCols.length && !parentCols.some(c => c.name === 'email')) {
  db.exec(`ALTER TABLE parents ADD COLUMN email TEXT;
           ALTER TABLE parents ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;`);
}

const apptCols = db.prepare("PRAGMA table_info(appointments)").all();
if (apptCols.length && !apptCols.some(c => c.name === 'type')) {
  db.exec(`
    ALTER TABLE appointments RENAME TO appointments_old;
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'appointment',
      title TEXT NOT NULL, kid_id INTEGER, date TEXT NOT NULL, time TEXT, notes TEXT,
      parent_id INTEGER, confirmed INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO appointments (id, title, kid_id, date, time, notes, parent_id, created_by, created_at)
      SELECT id, title, kid_id, date, time, notes, COALESCE(covered_by, parent_id), created_by, created_at FROM appointments_old;
    DROP TABLE appointments_old;
    DROP TABLE IF EXISTS pattern;
  `);
} else if (apptCols.length && !apptCols.some(c => c.name === 'confirmed')) {
  // v2 -> v3: covered_by folded into parent_id, everything existing counts as agreed.
  db.exec(`
    ALTER TABLE appointments RENAME TO appointments_old;
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'appointment',
      title TEXT NOT NULL, kid_id INTEGER, date TEXT NOT NULL, time TEXT, notes TEXT,
      parent_id INTEGER, confirmed INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO appointments (id, type, title, kid_id, date, time, notes, parent_id, created_by, created_at)
      SELECT id, type, title, kid_id, date, time, notes, COALESCE(covered_by, parent_id), created_by, created_at FROM appointments_old;
    DROP TABLE appointments_old;
  `);
}
// Old requests table is superseded by proposals; history is not worth migrating.
db.exec(`DROP TABLE IF EXISTS requests;`);

// ---------- helpers ----------
const now = () => new Date().toISOString();
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');

function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return res.status(401).json({ error: 'Session expired. Sign in again.' });
  req.parentId = s.parent_id;
  next();
}

function otherParent(id) {
  const row = db.prepare('SELECT id FROM parents WHERE id != ?').get(id);
  return row ? row.id : null;
}
const pRow = id => db.prepare('SELECT * FROM parents WHERE id = ?').get(id);
const pName = id => pRow(id)?.name || '';
// Email address for a parent, or null if they've turned notifications off / have no email.
const mailTo = id => { const p = pRow(id); return (p && p.notify && p.email) ? p.email : null; };
const kidName = id => id ? (db.prepare('SELECT name FROM kids WHERE id = ?').get(id)?.name || null) : null;

const app = express();
app.use(express.json());

// The service worker must NEVER be cached by the browser — if it is, a redeploy
// can leave a phone stuck on old code forever.
app.get('/sw.js', (req, res) => {
  res.set({
    'Content-Type': 'application/javascript',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/'
  });
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// API responses are live data — never let a proxy or browser cache them.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- setup & login ----------
app.get('/api/state', (req, res) => {
  const parents = db.prepare('SELECT id, name, color FROM parents ORDER BY id').all();
  res.json({ needsSetup: parents.length < 2, parents });
});

app.post('/api/setup', (req, res) => {
  const existing = db.prepare('SELECT COUNT(*) c FROM parents').get().c;
  if (existing >= 2) return res.status(400).json({ error: 'Already set up' });
  const { parents, kids } = req.body || {};
  if (!Array.isArray(parents) || parents.length !== 2)
    return res.status(400).json({ error: 'Two parents are required' });
  for (const p of parents) {
    if (!p.name || !p.pin || String(p.pin).length < 4)
      return res.status(400).json({ error: 'Each parent needs a name and a PIN of at least 4 digits' });
  }
  const ins = db.prepare('INSERT INTO parents (id, name, color, email, notify, pin_salt, pin_hash) VALUES (?,?,?,?,1,?,?)');
  db.prepare('DELETE FROM parents').run();
  parents.forEach((p, i) => {
    const salt = crypto.randomBytes(8).toString('hex');
    ins.run(i + 1, p.name.trim(), p.color || (i === 0 ? '#2F6D62' : '#C0702A'),
            (p.email || '').trim() || null, salt, hashPin(p.pin, salt));
  });
  if (Array.isArray(kids)) {
    const ki = db.prepare('INSERT INTO kids (name) VALUES (?)');
    kids.filter(k => k && k.trim()).forEach(k => ki.run(k.trim()));
  }
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { parent_id, pin } = req.body || {};
  const p = db.prepare('SELECT * FROM parents WHERE id = ?').get(parent_id);
  if (!p || hashPin(pin || '', p.pin_salt) !== p.pin_hash)
    return res.status(401).json({ error: 'Wrong PIN' });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, parent_id, created_at) VALUES (?,?,?)').run(token, p.id, now());
  res.json({ token, parent: { id: p.id, name: p.name, color: p.color } });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.headers['x-token']);
  res.json({ ok: true });
});

// ---------- main data feed ----------
app.get('/api/data', auth, (req, res) => {
  const month = req.query.month; // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });
  const parents = db.prepare('SELECT id, name, color, email, notify FROM parents ORDER BY id').all();
  const kids = db.prepare('SELECT * FROM kids ORDER BY name').all();
  const schedule = db.prepare('SELECT anchor_date, anchor_parent FROM schedule WHERE id = 1').get() || null;
  const overrides = db.prepare("SELECT * FROM overrides WHERE date LIKE ?").all(month + '%');
  // Regular items in this month, plus birthdays whose MM matches (they recur yearly).
  const appointments = db.prepare(`
    SELECT * FROM appointments
    WHERE (date LIKE ? AND type != 'birthday')
       OR (type = 'birthday' AND substr(date, 6, 2) = ?)
    ORDER BY date, time IS NULL, time
  `).all(month + '%', month.slice(5, 7));

  // All pending proposals (any month — you should always see what's waiting), plus recent history.
  const pending = db.prepare(`
    SELECT p.*, a.title, a.type AS item_type, a.date AS item_date, a.time AS item_time, a.kid_id
    FROM proposals p LEFT JOIN appointments a ON a.id = p.appointment_id
    WHERE p.status = 'pending' ORDER BY p.created_at DESC
  `).all();
  const history = db.prepare(`
    SELECT p.*, a.title, a.type AS item_type, a.date AS item_date, a.time AS item_time, a.kid_id
    FROM proposals p LEFT JOIN appointments a ON a.id = p.appointment_id
    WHERE p.status != 'pending' ORDER BY p.responded_at DESC LIMIT 20
  `).all();

  res.json({ me: req.parentId, parents, kids, schedule, overrides, appointments,
             pending, history, mailReady: mail.enabled });
});

// ---------- notification settings ----------
app.post('/api/me', auth, (req, res) => {
  const { email, notify } = req.body || {};
  const e = (email || '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    return res.status(400).json({ error: "That doesn't look like an email address" });
  db.prepare('UPDATE parents SET email = ?, notify = ? WHERE id = ?')
    .run(e || null, notify ? 1 : 0, req.parentId);
  res.json({ ok: true });
});

// ---------- custody schedule (alternating weeks) ----------
app.post('/api/schedule', auth, (req, res) => {
  const { anchor_date, anchor_parent } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor_date || '') || !anchor_parent)
    return res.status(400).json({ error: 'anchor_date and anchor_parent required' });
  db.prepare(`INSERT INTO schedule (id, anchor_date, anchor_parent) VALUES (1,?,?)
              ON CONFLICT(id) DO UPDATE SET anchor_date = excluded.anchor_date, anchor_parent = excluded.anchor_parent`)
    .run(anchor_date, anchor_parent);
  res.json({ ok: true });
});

// ---------- kids ----------
app.post('/api/kids', auth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO kids (name) VALUES (?)').run(name);
  res.json({ id: r.lastInsertRowid, name });
});

app.delete('/api/kids/:id', auth, (req, res) => {
  db.prepare('UPDATE appointments SET kid_id = NULL WHERE kid_id = ?').run(req.params.id);
  db.prepare('DELETE FROM kids WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- proposals ----------
// Anything that puts an obligation on the other parent is a PROPOSAL: it only
// takes effect once they accept. Anything that only affects yourself is immediate.
const ITEM_TYPES = ['appointment', 'event', 'birthday'];
const EDIT_FIELDS = ['title', 'kid_id', 'date', 'time', 'notes', 'parent_id'];

function propose({ kind, from, to, appointment_id = null, date = null, to_parent_on_date = null, payload = null, message = null }) {
  const r = db.prepare(`INSERT INTO proposals (kind, appointment_id, date, to_parent_on_date, payload, from_parent, to_parent, message, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kind, appointment_id, date, to_parent_on_date, payload ? JSON.stringify(payload) : null, from, to, message, now());
  return r.lastInsertRowid;
}

// ---------- appointments ----------
app.post('/api/appointments', auth, (req, res) => {
  const { type, title, kid_id, date, time, notes, parent_id, message } = req.body || {};
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    return res.status(400).json({ error: 'Title and date are required' });
  const t = ITEM_TYPES.includes(type) ? type : 'appointment';
  const other = otherParent(req.parentId);
  // Birthdays have no owner; events may be unassigned; appointments default to the creator.
  const pid = t === 'birthday' ? null : (t === 'event' ? (parent_id || null) : (parent_id || req.parentId));

  // Assigning the OTHER parent needs their approval — the item lands unconfirmed.
  const needsApproval = !!pid && pid === other;

  const r = db.prepare(`INSERT INTO appointments (type, title, kid_id, date, time, notes, parent_id, confirmed, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(t, title.trim(), kid_id || null, date, t === 'birthday' ? null : (time || null),
         notes || null, pid, needsApproval ? 0 : 1, req.parentId, now());
  const id = r.lastInsertRowid;

  const item = { id, type: t, title: title.trim(), date, time: t === 'birthday' ? null : (time || null), notes: notes || null };

  if (needsApproval) {
    propose({ kind: 'assign', from: req.parentId, to: other, appointment_id: id, message: message || null });
    const addr = mailTo(other);
    if (addr) mail.approvalNeeded({
      to: addr, actor: pName(req.parentId), kind: 'assign', item,
      kid: kidName(kid_id), message: message || null
    });
  } else {
    const addr = mailTo(other);
    if (addr) mail.itemAdded({
      to: addr, actor: pName(req.parentId), item, kid: kidName(kid_id), owner: pid ? pName(pid) : null
    });
  }

  res.json({ id, pending: needsApproval });
});

app.put('/api/appointments/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const other = otherParent(req.parentId);
  const t = ITEM_TYPES.includes(b.type) ? b.type : a.type;

  // Build the proposed new row.
  const next = {
    type: t,
    title: b.title ?? a.title,
    kid_id: 'kid_id' in b ? b.kid_id : a.kid_id,
    date: b.date ?? a.date,
    time: t === 'birthday' ? null : ('time' in b ? b.time : a.time),
    notes: 'notes' in b ? b.notes : a.notes,
    parent_id: t === 'birthday' ? null : ('parent_id' in b ? b.parent_id : a.parent_id)
  };

  // Does this edit change something the OTHER parent is on the hook for?
  const wasTheirs = a.parent_id === other;
  const nowTheirs = next.parent_id === other;
  const materiallyChanged = EDIT_FIELDS.some(f => (next[f] ?? null) !== (a[f] ?? null));
  // Their approval is needed if they're being put on it, or if a commitment they
  // already agreed to is being changed in any way.
  const needsApproval = nowTheirs && materiallyChanged && !(wasTheirs && !a.confirmed);

  if (needsApproval) {
    // Cancel any older pending proposal on this item, then propose the edit.
    db.prepare("UPDATE proposals SET status='cancelled', responded_at=? WHERE appointment_id=? AND status='pending'")
      .run(now(), a.id);
    // If it was never theirs before, this is an assignment; otherwise it's a change to their commitment.
    const kind = wasTheirs ? 'edit' : 'reassign';
    propose({ kind, from: req.parentId, to: other, appointment_id: a.id, payload: next, message: b.message || null });

    const addr = mailTo(other);
    if (addr) mail.approvalNeeded({
      to: addr, actor: pName(req.parentId), kind,
      item: { ...next, id: a.id }, prev: a, kid: kidName(next.kid_id), message: b.message || null
    });
    return res.json({ ok: true, pending: true });
  }

  // No approval needed — apply straight away. If it was theirs and is now yours/nobody's,
  // any pending proposal on it is moot.
  if (wasTheirs && !nowTheirs) {
    db.prepare("UPDATE proposals SET status='cancelled', responded_at=? WHERE appointment_id=? AND status='pending'")
      .run(now(), a.id);
  }
  db.prepare(`UPDATE appointments SET type=?, title=?, kid_id=?, date=?, time=?, notes=?, parent_id=?, confirmed=? WHERE id=?`)
    .run(next.type, next.title, next.kid_id, next.date, next.time, next.notes, next.parent_id,
         nowTheirs ? a.confirmed : 1, a.id);

  if (materiallyChanged) {
    const addr = mailTo(other);
    if (addr) mail.itemAdded({
      to: addr, actor: pName(req.parentId), item: { ...next, id: a.id },
      kid: kidName(next.kid_id), owner: next.parent_id ? pName(next.parent_id) : null, edited: true
    });
  }
  res.json({ ok: true });
});

app.delete('/api/appointments/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  db.prepare("UPDATE proposals SET status='cancelled', responded_at=? WHERE appointment_id=? AND status='pending'")
    .run(now(), req.params.id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  if (a) {
    const addr = mailTo(otherParent(req.parentId));
    if (addr) mail.itemDeleted({ to: addr, actor: pName(req.parentId), item: a });
  }
  res.json({ ok: true });
});

// Hand an appointment you own to the other parent (the "can you cover this?" flow).
app.post('/api/appointments/:id/handoff', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.type === 'birthday') return res.status(400).json({ error: "Birthdays don't need anyone to take them" });
  const other = otherParent(req.parentId);
  if (!other) return res.status(400).json({ error: 'No other parent configured' });
  if (a.parent_id === other) return res.status(400).json({ error: `That's already ${pName(other)}'s` });
  const dupe = db.prepare("SELECT id FROM proposals WHERE appointment_id=? AND status='pending'").get(a.id);
  if (dupe) return res.status(400).json({ error: 'Something on this is already waiting for a reply' });

  const next = { type: a.type, title: a.title, kid_id: a.kid_id, date: a.date, time: a.time, notes: a.notes, parent_id: other };
  propose({ kind: 'reassign', from: req.parentId, to: other, appointment_id: a.id, payload: next, message: req.body?.message || null });

  const addr = mailTo(other);
  if (addr) mail.approvalNeeded({
    to: addr, actor: pName(req.parentId), kind: 'reassign', item: a, kid: kidName(a.kid_id), message: req.body?.message || null
  });
  res.json({ ok: true, pending: true });
});

// ---------- custody day swaps ----------
// Proposing a swap does NOT change the calendar until the other parent accepts.
app.post('/api/swap', auth, (req, res) => {
  const { date, parent_id, message } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Bad date' });
  const other = otherParent(req.parentId);
  if (!other) return res.status(400).json({ error: 'No other parent configured' });
  const dupe = db.prepare("SELECT id FROM proposals WHERE kind='swap_day' AND date=? AND status='pending'").get(date);
  if (dupe) return res.status(400).json({ error: 'A swap for this day is already waiting for a reply' });

  propose({ kind: 'swap_day', from: req.parentId, to: other, date, to_parent_on_date: parent_id || null, message: message || null });

  const addr = mailTo(other);
  if (addr) mail.approvalNeeded({
    to: addr, actor: pName(req.parentId), kind: 'swap_day',
    date, newOwner: parent_id ? pName(parent_id) : null, message: message || null
  });
  res.json({ ok: true, pending: true });
});

// ---------- respond to / cancel a proposal ----------
app.post('/api/proposals/:id/respond', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!p || p.status !== 'pending') return res.status(400).json({ error: 'This is no longer pending' });
  if (p.to_parent !== req.parentId) return res.status(403).json({ error: "This isn't yours to answer" });
  const accept = !!req.body?.accept;

  db.prepare('UPDATE proposals SET status=?, responded_at=? WHERE id=?')
    .run(accept ? 'accepted' : 'declined', now(), p.id);

  const a = p.appointment_id ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(p.appointment_id) : null;

  if (accept) {
    if (p.kind === 'swap_day') {
      if (p.to_parent_on_date)
        db.prepare('INSERT INTO overrides (date, parent_id) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET parent_id = excluded.parent_id')
          .run(p.date, p.to_parent_on_date);
      else
        db.prepare('DELETE FROM overrides WHERE date = ?').run(p.date);
    } else if (a) {
      const n = p.payload ? JSON.parse(p.payload) : null;
      if (n) {
        db.prepare(`UPDATE appointments SET type=?, title=?, kid_id=?, date=?, time=?, notes=?, parent_id=?, confirmed=1 WHERE id=?`)
          .run(n.type ?? a.type, n.title, n.kid_id, n.date, n.time, n.notes, n.parent_id, a.id);
      } else {
        // 'assign' proposals carry no payload — the row is already correct, just unconfirmed.
        db.prepare('UPDATE appointments SET confirmed=1 WHERE id=?').run(a.id);
      }
    }
  } else if (a && (p.kind === 'assign' || p.kind === 'reassign')) {
    // Declined: nobody is on it until one of you claims it.
    db.prepare('UPDATE appointments SET parent_id=NULL, confirmed=1 WHERE id=?').run(a.id);
  }
  // A declined 'edit' leaves the appointment exactly as it was — nothing to undo.

  const addr = mailTo(p.from_parent);
  if (addr) mail.proposalAnswered({
    to: addr, actor: pName(req.parentId), kind: p.kind, accepted: accept,
    item: a, date: p.date, newOwner: p.to_parent_on_date ? pName(p.to_parent_on_date) : null
  });

  res.json({ ok: true });
});

app.post('/api/proposals/:id/cancel', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!p || p.status !== 'pending') return res.status(400).json({ error: 'This is no longer pending' });
  if (p.from_parent !== req.parentId) return res.status(403).json({ error: 'Only the sender can withdraw this' });
  db.prepare("UPDATE proposals SET status='cancelled', responded_at=? WHERE id=?").run(now(), p.id);
  // Withdrawing an assignment leaves the item unowned rather than stranding it on them.
  if (p.kind === 'assign' && p.appointment_id)
    db.prepare('UPDATE appointments SET parent_id=NULL, confirmed=1 WHERE id=? AND confirmed=0').run(p.appointment_id);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Co-parent calendar running on :${PORT}, data in ${DATA_DIR}`));
