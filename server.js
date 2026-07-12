const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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
  date TEXT PRIMARY KEY,            -- YYYY-MM-DD
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
  parent_id INTEGER,                -- responsible parent (NULL = both/everyone)
  covered_by INTEGER,               -- set when other parent accepted coverage
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL,
  from_parent INTEGER NOT NULL,
  to_parent INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | declined | cancelled
  created_at TEXT NOT NULL,
  responded_at TEXT
);
`);

// Migrate databases created by the earlier weekday-pattern version.
const apptCols = db.prepare("PRAGMA table_info(appointments)").all();
if (apptCols.length && !apptCols.some(c => c.name === 'type')) {
  db.exec(`
    ALTER TABLE appointments RENAME TO appointments_old;
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'appointment',
      title TEXT NOT NULL, kid_id INTEGER, date TEXT NOT NULL, time TEXT, notes TEXT,
      parent_id INTEGER, covered_by INTEGER, created_by INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO appointments (id, title, kid_id, date, time, notes, parent_id, covered_by, created_by, created_at)
      SELECT id, title, kid_id, date, time, notes, parent_id, covered_by, created_by, created_at FROM appointments_old;
    DROP TABLE appointments_old;
    DROP TABLE IF EXISTS pattern;
  `);
}

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

const app = express();
app.use(express.json());
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
  const ins = db.prepare('INSERT INTO parents (id, name, color, pin_salt, pin_hash) VALUES (?,?,?,?,?)');
  db.prepare('DELETE FROM parents').run();
  parents.forEach((p, i) => {
    const salt = crypto.randomBytes(8).toString('hex');
    ins.run(i + 1, p.name.trim(), p.color || (i === 0 ? '#2F6D62' : '#C0702A'), salt, hashPin(p.pin, salt));
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
  const parents = db.prepare('SELECT id, name, color FROM parents ORDER BY id').all();
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
  const requests = db.prepare(`
    SELECT r.*, a.title, a.date, a.time, a.kid_id
    FROM requests r JOIN appointments a ON a.id = r.appointment_id
    WHERE r.from_parent = ? OR r.to_parent = ?
    ORDER BY r.created_at DESC LIMIT 50
  `).all(req.parentId, req.parentId);
  res.json({ me: req.parentId, parents, kids, schedule, overrides, appointments, requests });
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

app.post('/api/override', auth, (req, res) => {
  const { date, parent_id } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Bad date' });
  if (parent_id) {
    db.prepare('INSERT INTO overrides (date, parent_id) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET parent_id = excluded.parent_id')
      .run(date, parent_id);
  } else {
    db.prepare('DELETE FROM overrides WHERE date = ?').run(date);
  }
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

// ---------- appointments ----------
const ITEM_TYPES = ['appointment', 'event', 'birthday'];

app.post('/api/appointments', auth, (req, res) => {
  const { type, title, kid_id, date, time, notes, parent_id } = req.body || {};
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    return res.status(400).json({ error: 'Title and date are required' });
  const t = ITEM_TYPES.includes(type) ? type : 'appointment';
  // Appointments need a responsible parent; events can be "both" (null); birthdays never have one.
  const pid = t === 'birthday' ? null : (t === 'event' ? (parent_id || null) : (parent_id || req.parentId));
  const r = db.prepare(`INSERT INTO appointments (type, title, kid_id, date, time, notes, parent_id, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(t, title.trim(), kid_id || null, date, t === 'birthday' ? null : (time || null), notes || null, pid, req.parentId, now());
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/appointments/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const t = ITEM_TYPES.includes(b.type) ? b.type : a.type;
  let pid = 'parent_id' in b ? b.parent_id : a.parent_id;
  if (t === 'birthday') pid = null;
  const changedOwner = pid !== a.parent_id;
  db.prepare(`UPDATE appointments SET type=?, title=?, kid_id=?, date=?, time=?, notes=?, parent_id=?,
              covered_by=CASE WHEN ? THEN NULL ELSE covered_by END WHERE id=?`)
    .run(t, b.title ?? a.title, 'kid_id' in b ? b.kid_id : a.kid_id, b.date ?? a.date,
         t === 'birthday' ? null : ('time' in b ? b.time : a.time),
         'notes' in b ? b.notes : a.notes, pid, changedOwner ? 1 : 0, a.id);
  res.json({ ok: true });
});

app.delete('/api/appointments/:id', auth, (req, res) => {
  db.prepare("UPDATE requests SET status='cancelled', responded_at=? WHERE appointment_id=? AND status='pending'")
    .run(now(), req.params.id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- coverage requests ----------
app.post('/api/requests', auth, (req, res) => {
  const { appointment_id, message } = req.body || {};
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment_id);
  if (!a) return res.status(404).json({ error: 'Appointment not found' });
  if (!a.parent_id) return res.status(400).json({ error: 'This item has no responsible parent to swap' });
  const to = otherParent(req.parentId);
  if (!to) return res.status(400).json({ error: 'No other parent configured' });
  const dupe = db.prepare("SELECT id FROM requests WHERE appointment_id=? AND status='pending'").get(appointment_id);
  if (dupe) return res.status(400).json({ error: 'A request for this appointment is already pending' });
  const r = db.prepare(`INSERT INTO requests (appointment_id, from_parent, to_parent, message, created_at)
    VALUES (?,?,?,?,?)`).run(appointment_id, req.parentId, to, message || null, now());
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/requests/:id/respond', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });
  if (r.to_parent !== req.parentId) return res.status(403).json({ error: 'This request is not addressed to you' });
  const accept = !!req.body?.accept;
  db.prepare('UPDATE requests SET status=?, responded_at=? WHERE id=?')
    .run(accept ? 'accepted' : 'declined', now(), r.id);
  if (accept) {
    db.prepare('UPDATE appointments SET covered_by=? WHERE id=?').run(req.parentId, r.appointment_id);
  }
  res.json({ ok: true });
});

app.post('/api/requests/:id/cancel', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });
  if (r.from_parent !== req.parentId) return res.status(403).json({ error: 'Only the sender can cancel' });
  db.prepare("UPDATE requests SET status='cancelled', responded_at=? WHERE id=?").run(now(), r.id);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Co-parent calendar running on :${PORT}, data in ${DATA_DIR}`));
