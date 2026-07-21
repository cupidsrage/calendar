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
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by   INTEGER NOT NULL,          -- parent who logged/paid it
  owed_by      INTEGER NOT NULL,          -- the OTHER parent (who owes their share)
  amount_cents INTEGER NOT NULL,          -- total cost, in cents (never floats)
  split_pct    INTEGER NOT NULL DEFAULT 50, -- owed_by's share, 0..100 (50 = even)
  description  TEXT NOT NULL,
  category     TEXT,                      -- medical | school | clothing | activities | other
  kid_id       INTEGER,                   -- optional tag
  date         TEXT NOT NULL,             -- YYYY-MM-DD the cost was incurred
  type         TEXT NOT NULL,             -- necessity | request
  -- necessity starts 'owed' (auto-owed, disputable); request starts 'pending'.
  status       TEXT NOT NULL,             -- pending | owed | declined | disputed | settled
  settle_id    INTEGER,                   -- groups rows zeroed out in one settle-up
  created_at   TEXT NOT NULL,
  responded_at TEXT
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_parent  INTEGER NOT NULL,          -- who handed over the money
  to_parent    INTEGER NOT NULL,          -- who received it
  amount_cents INTEGER NOT NULL,          -- how much was actually paid (partial allowed)
  note         TEXT,
  created_at   TEXT NOT NULL
);
`);

// The live `settlements` table went through several earlier shapes (a NOT NULL `by_parent`
// column, missing from_parent/to_parent, etc.). CREATE TABLE IF NOT EXISTS can't reshape an
// existing table, so if the columns don't match the canonical set, rebuild it once —
// preserving existing rows and mapping any legacy `by_parent` onto `from_parent`.
const settleCols = db.prepare("PRAGMA table_info(settlements)").all();
if (settleCols.length) {
  const names = settleCols.map(c => c.name);
  const canonical = ['id', 'from_parent', 'to_parent', 'amount_cents', 'note', 'created_at'];
  const hasAllCanonical = canonical.every(c => names.includes(c));
  const hasOrphans = names.some(n => !canonical.includes(n));
  if (!hasAllCanonical || hasOrphans) {
    const has = n => names.includes(n);
    // Best-effort source expressions for each target column from whatever exists now.
    const fromExpr   = has('from_parent') ? 'from_parent' : (has('by_parent') ? 'by_parent' : 'NULL');
    const toExpr     = has('to_parent') ? 'to_parent' : 'NULL';
    const amtExpr    = has('amount_cents') ? 'amount_cents' : (has('amount') ? 'amount' : '0');
    const noteExpr   = has('note') ? 'note' : 'NULL';
    const createdExpr= has('created_at') ? 'created_at' : "''";
    db.exec('BEGIN');
    try {
      db.exec(`
        ALTER TABLE settlements RENAME TO settlements_legacy;
        CREATE TABLE settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_parent  INTEGER NOT NULL,
          to_parent    INTEGER NOT NULL,
          amount_cents INTEGER NOT NULL,
          note         TEXT,
          created_at   TEXT NOT NULL
        );
        INSERT INTO settlements (id, from_parent, to_parent, amount_cents, note, created_at)
          SELECT id,
                 COALESCE(${fromExpr}, 0),
                 COALESCE(${toExpr}, 0),
                 COALESCE(${amtExpr}, 0),
                 ${noteExpr},
                 COALESCE(NULLIF(${createdExpr}, ''), '1970-01-01T00:00:00.000Z')
          FROM settlements_legacy;
        DROP TABLE settlements_legacy;
      `);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

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
// Kid logins: give kids optional PIN credentials (nullable — existing kids just have no login yet).
const kidCols = db.prepare("PRAGMA table_info(kids)").all();
if (kidCols.length && !kidCols.some(c => c.name === 'pin_hash')) {
  db.exec(`ALTER TABLE kids ADD COLUMN pin_salt TEXT;
           ALTER TABLE kids ADD COLUMN pin_hash TEXT;`);
}
// Sessions can belong to a parent or a kid; add nullable kid_id and relax parent_id.
const sessCols = db.prepare("PRAGMA table_info(sessions)").all();
if (sessCols.length && !sessCols.some(c => c.name === 'kid_id')) {
  db.exec(`
    ALTER TABLE sessions RENAME TO sessions_old;
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      parent_id INTEGER,
      kid_id INTEGER,
      created_at TEXT NOT NULL
    );
    INSERT INTO sessions (token, parent_id, kid_id, created_at)
      SELECT token, parent_id, NULL, created_at FROM sessions_old;
    DROP TABLE sessions_old;
  `);
}

// Old requests table is superseded by proposals; history is not worth migrating.
db.exec(`DROP TABLE IF EXISTS requests;`);

// Multi-day events: optional end_date (YYYY-MM-DD). NULL = single-day, unchanged behavior.
const apptCols2 = db.prepare("PRAGMA table_info(appointments)").all();
if (apptCols2.length && !apptCols2.some(c => c.name === 'end_date')) {
  db.exec(`ALTER TABLE appointments ADD COLUMN end_date TEXT;`);
}

// ---------- helpers ----------
const now = () => new Date().toISOString();
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');

function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return res.status(401).json({ error: 'Session expired. Sign in again.' });
  req.parentId = s.parent_id;      // null for kid sessions
  req.kidId = s.kid_id;            // null for parent sessions
  req.role = s.kid_id ? 'kid' : 'parent';
  next();
}

// Gate mutating routes: kids can read but never write.
function parentOnly(req, res, next) {
  if (req.role !== 'parent') return res.status(403).json({ error: 'View-only account' });
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

// ---------- current weather (Cabot, Arkansas) ----------
// Open-Meteo needs no API key. Keep the coordinates fixed so both parents see
// the same local conditions, and cache upstream responses to avoid noisy polling.
const CABOT_WEATHER = {
  latitude: 34.9745,
  longitude: -92.0165,
  location: 'Cabot, AR',
  timezone: 'America/Chicago'
};
const WEATHER_CACHE_MS = 10 * 60 * 1000;
let weatherCache = { fetchedAt: 0, data: null };

function weatherCondition(code) {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  return 'cloudy';
}

function weatherDescription(code) {
  const descriptions = {
    0:'Clear sky', 1:'Mostly clear', 2:'Partly cloudy', 3:'Overcast',
    45:'Fog', 48:'Freezing fog', 51:'Light drizzle', 53:'Drizzle', 55:'Heavy drizzle',
    56:'Light freezing drizzle', 57:'Freezing drizzle', 61:'Light rain', 63:'Rain',
    65:'Heavy rain', 66:'Light freezing rain', 67:'Freezing rain', 71:'Light snow',
    73:'Snow', 75:'Heavy snow', 77:'Snow grains', 80:'Light rain showers',
    81:'Rain showers', 82:'Heavy rain showers', 85:'Light snow showers',
    86:'Heavy snow showers', 95:'Thunderstorms', 96:'Thunderstorms with hail',
    99:'Severe thunderstorms with hail'
  };
  return descriptions[code] || 'Cloudy';
}

function weatherIcon(condition, isDay) {
  if (condition === 'clear') return isDay ? '☀️' : '🌙';
  if (condition === 'partly-cloudy') return isDay ? '🌤️' : '☁️';
  if (condition === 'cloudy') return '☁️';
  if (condition === 'fog') return '🌫️';
  if (condition === 'rain') return '🌧️';
  if (condition === 'snow') return '🌨️';
  if (condition === 'storm') return '⛈️';
  return '☁️';
}

async function getCabotWeather() {
  const fetchedAt = Date.now();
  if (weatherCache.data && fetchedAt - weatherCache.fetchedAt < WEATHER_CACHE_MS)
    return weatherCache.data;

  const params = new URLSearchParams({
    latitude: String(CABOT_WEATHER.latitude),
    longitude: String(CABOT_WEATHER.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,precipitation,rain,showers,snowfall,cloud_cover,is_day,wind_speed_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: CABOT_WEATHER.timezone,
    forecast_days: '1'
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CoParentCalendar/1.0' }
    });
    if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
    const payload = await response.json();
    const current = payload.current;
    if (!current || !Number.isFinite(current.weather_code) || !Number.isFinite(current.temperature_2m))
      throw new Error('Open-Meteo response was missing current conditions');

    const condition = weatherCondition(current.weather_code);
    const result = {
      location: CABOT_WEATHER.location,
      observed_at: current.time,
      date: current.time.slice(0, 10),
      temperature_f: Math.round(current.temperature_2m),
      apparent_temperature_f: Number.isFinite(current.apparent_temperature)
        ? Math.round(current.apparent_temperature) : Math.round(current.temperature_2m),
      weather_code: current.weather_code,
      condition,
      description: weatherDescription(current.weather_code),
      icon: weatherIcon(condition, current.is_day === 1),
      is_day: current.is_day === 1,
      precipitation_in: current.precipitation,
      snowfall_in: current.snowfall,
      cloud_cover: current.cloud_cover,
      wind_mph: current.wind_speed_10m,
      stale: false,
      source: 'Open-Meteo'
    };
    weatherCache = { fetchedAt, data: result };
    return result;
  } catch (error) {
    if (weatherCache.data) return { ...weatherCache.data, stale: true };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/weather', auth, async (req, res) => {
  try {
    res.json(await getCabotWeather());
  } catch (error) {
    console.warn('[weather] Current conditions unavailable:', error.message);
    res.status(503).json({ error: 'Current weather is temporarily unavailable' });
  }
});

// ---------- setup & login ----------
app.get('/api/state', (req, res) => {
  const parents = db.prepare('SELECT id, name, color FROM parents ORDER BY id').all();
  // Only kids who have a PIN set can sign in — surface them for the login picker.
  const kidLogins = db.prepare('SELECT id, name FROM kids WHERE pin_hash IS NOT NULL ORDER BY name').all();
  res.json({ needsSetup: parents.length < 2, parents, kidLogins });
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

app.post('/api/kid-login', (req, res) => {
  const { kid_id, pin } = req.body || {};
  const k = db.prepare('SELECT * FROM kids WHERE id = ?').get(kid_id);
  if (!k || !k.pin_hash || hashPin(pin || '', k.pin_salt) !== k.pin_hash)
    return res.status(401).json({ error: 'Wrong PIN' });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, parent_id, kid_id, created_at) VALUES (?,?,?,?)')
    .run(token, null, k.id, now());
  res.json({ token, kid: { id: k.id, name: k.name } });
});

// Parents set or clear a kid's PIN (enables/disables that kid's read-only login).
app.post('/api/kids/:id/pin', auth, parentOnly, (req, res) => {
  const k = db.prepare('SELECT id FROM kids WHERE id = ?').get(req.params.id);
  if (!k) return res.status(404).json({ error: 'No such kid' });
  const { pin } = req.body || {};
  if (pin === null || pin === '') {
    db.prepare('UPDATE kids SET pin_salt = NULL, pin_hash = NULL WHERE id = ?').run(k.id);
    return res.json({ ok: true, hasPin: false });
  }
  if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare('UPDATE kids SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hashPin(pin, salt), k.id);
  res.json({ ok: true, hasPin: true });
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
  // Regular items in this month, plus birthdays whose MM matches (they recur yearly),
  // plus multi-day events whose range overlaps this month (may start before / end after).
  const mStart = month + '-01';
  const mEnd = month + '-31';
  const appointments = db.prepare(`
    SELECT * FROM appointments
    WHERE (date LIKE ? AND type != 'birthday')
       OR (type = 'birthday' AND substr(date, 6, 2) = ?)
       OR (end_date IS NOT NULL AND date <= ? AND end_date >= ?)
    ORDER BY date, time IS NULL, time
  `).all(month + '%', month.slice(5, 7), mEnd, mStart);

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

  if (req.role === 'kid') {
    // Kids see the calendar and appointments, but not the parent proposal/swap back-and-forth.
    return res.json({ role: 'kid', me: null, kidId: req.kidId,
      parents: parents.map(p => ({ id: p.id, name: p.name, color: p.color })),
      kids: kids.map(k => ({ id: k.id, name: k.name })),
      schedule, overrides, appointments, pending: [], history: [], mailReady: false });
  }
  // Parents: full view. Flag which kids have a login PIN set, for the settings screen.
  const kidsOut = kids.map(k => ({ id: k.id, name: k.name, hasPin: !!k.pin_hash }));
  res.json({ role: 'parent', me: req.parentId, parents, kids: kidsOut, schedule, overrides,
             appointments, pending, history, mailReady: mail.enabled });
});

// ---------- notification settings ----------
app.post('/api/me', auth, parentOnly, (req, res) => {
  const { email, notify } = req.body || {};
  const e = (email || '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    return res.status(400).json({ error: "That doesn't look like an email address" });
  db.prepare('UPDATE parents SET email = ?, notify = ? WHERE id = ?')
    .run(e || null, notify ? 1 : 0, req.parentId);
  res.json({ ok: true });
});

// ---------- custody schedule (alternating weeks) ----------
app.post('/api/schedule', auth, parentOnly, (req, res) => {
  const { anchor_date, anchor_parent } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor_date || '') || !anchor_parent)
    return res.status(400).json({ error: 'anchor_date and anchor_parent required' });
  db.prepare(`INSERT INTO schedule (id, anchor_date, anchor_parent) VALUES (1,?,?)
              ON CONFLICT(id) DO UPDATE SET anchor_date = excluded.anchor_date, anchor_parent = excluded.anchor_parent`)
    .run(anchor_date, anchor_parent);
  res.json({ ok: true });
});

// ---------- kids ----------
app.post('/api/kids', auth, parentOnly, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO kids (name) VALUES (?)').run(name);
  res.json({ id: r.lastInsertRowid, name });
});

app.delete('/api/kids/:id', auth, parentOnly, (req, res) => {
  db.prepare('UPDATE appointments SET kid_id = NULL WHERE kid_id = ?').run(req.params.id);
  db.prepare('DELETE FROM kids WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- proposals ----------
// Anything that puts an obligation on the other parent is a PROPOSAL: it only
// takes effect once they accept. Anything that only affects yourself is immediate.
const ITEM_TYPES = ['appointment', 'event', 'birthday', 'oncall'];
const EDIT_FIELDS = ['title', 'kid_id', 'date', 'end_date', 'time', 'notes', 'parent_id'];

function propose({ kind, from, to, appointment_id = null, date = null, to_parent_on_date = null, payload = null, message = null }) {
  const r = db.prepare(`INSERT INTO proposals (kind, appointment_id, date, to_parent_on_date, payload, from_parent, to_parent, message, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kind, appointment_id, date, to_parent_on_date, payload ? JSON.stringify(payload) : null, from, to, message, now());
  return r.lastInsertRowid;
}

// ---------- appointments ----------
app.post('/api/appointments', auth, parentOnly, (req, res) => {
  const { type, title, kid_id, date, end_date, time, notes, parent_id, message } = req.body || {};
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    return res.status(400).json({ error: 'Title and date are required' });
  const t = ITEM_TYPES.includes(type) ? type : 'appointment';
  // Multi-day range applies to events and on-call periods. end >= start; store only genuine ranges.
  let endD = null;
  if ((t === 'event' || t === 'oncall') && end_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date))
      return res.status(400).json({ error: 'End date is invalid' });
    if (end_date < date)
      return res.status(400).json({ error: 'End date must be on or after the start date' });
    if (end_date !== date) endD = end_date;
  }
  const other = otherParent(req.parentId);
  // Birthdays have no owner; events may be unassigned; on-call is always the creator's own;
  // appointments default to the creator.
  const pid = t === 'birthday' ? null
            : t === 'oncall' ? req.parentId
            : (t === 'event' ? (parent_id || null) : (parent_id || req.parentId));

  // Assigning the OTHER parent needs their approval — the item lands unconfirmed.
  // On-call is awareness-only (you're flagging your own availability), so it never needs approval.
  const needsApproval = t !== 'oncall' && !!pid && pid === other;

  const r = db.prepare(`INSERT INTO appointments (type, title, kid_id, date, end_date, time, notes, parent_id, confirmed, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(t, title.trim(), kid_id || null, date, endD, t === 'birthday' ? null : (time || null),
         notes || null, pid, needsApproval ? 0 : 1, req.parentId, now());
  const id = r.lastInsertRowid;

  const item = { id, type: t, title: title.trim(), date, end_date: endD, time: t === 'birthday' ? null : (time || null), notes: notes || null };

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

app.put('/api/appointments/:id', auth, parentOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const other = otherParent(req.parentId);
  const t = ITEM_TYPES.includes(b.type) ? b.type : a.type;

  // Build the proposed new row.
  const startDate = b.date ?? a.date;
  let nextEnd = (t === 'event' || t === 'oncall') ? ('end_date' in b ? b.end_date : a.end_date) : null;
  if (nextEnd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextEnd) || nextEnd < startDate)
      return res.status(400).json({ error: 'End date must be a valid date on or after the start date' });
    if (nextEnd === startDate) nextEnd = null;   // collapse to single-day
  }
  const next = {
    type: t,
    title: b.title ?? a.title,
    kid_id: 'kid_id' in b ? b.kid_id : a.kid_id,
    date: startDate,
    end_date: nextEnd,
    time: t === 'birthday' ? null : ('time' in b ? b.time : a.time),
    notes: 'notes' in b ? b.notes : a.notes,
    // On-call stays owned by whoever it belongs to; birthdays have no owner.
    parent_id: t === 'birthday' ? null : ('parent_id' in b ? b.parent_id : a.parent_id)
  };

  // Does this edit change something the OTHER parent is on the hook for?
  // On-call is never an obligation on the other parent, so it never triggers approval.
  const wasTheirs = a.parent_id === other;
  const nowTheirs = next.parent_id === other;
  const materiallyChanged = EDIT_FIELDS.some(f => (next[f] ?? null) !== (a[f] ?? null));
  const needsApproval = t !== 'oncall' && nowTheirs && materiallyChanged && !(wasTheirs && !a.confirmed);

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
  db.prepare(`UPDATE appointments SET type=?, title=?, kid_id=?, date=?, end_date=?, time=?, notes=?, parent_id=?, confirmed=? WHERE id=?`)
    .run(next.type, next.title, next.kid_id, next.date, next.end_date, next.time, next.notes, next.parent_id,
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

app.delete('/api/appointments/:id', auth, parentOnly, (req, res) => {
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
app.post('/api/appointments/:id/handoff', auth, parentOnly, (req, res) => {
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
app.post('/api/swap', auth, parentOnly, (req, res) => {
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
app.post('/api/proposals/:id/respond', auth, parentOnly, (req, res) => {
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
        db.prepare(`UPDATE appointments SET type=?, title=?, kid_id=?, date=?, end_date=?, time=?, notes=?, parent_id=?, confirmed=1 WHERE id=?`)
          .run(n.type ?? a.type, n.title, n.kid_id, n.date, n.end_date ?? null, n.time, n.notes, n.parent_id, a.id);
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

app.post('/api/proposals/:id/cancel', auth, parentOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!p || p.status !== 'pending') return res.status(400).json({ error: 'This is no longer pending' });
  if (p.from_parent !== req.parentId) return res.status(403).json({ error: 'Only the sender can withdraw this' });
  db.prepare("UPDATE proposals SET status='cancelled', responded_at=? WHERE id=?").run(now(), p.id);
  // Withdrawing an assignment leaves the item unowned rather than stranding it on them.
  if (p.kind === 'assign' && p.appointment_id)
    db.prepare('UPDATE appointments SET parent_id=NULL, confirmed=1 WHERE id=? AND confirmed=0').run(p.appointment_id);
  res.json({ ok: true });
});

// ---------- expenses (shared-cost splitting) ----------
// Two flavors:
//   necessity — a shared cost that's owed by default. Lands as 'owed'. The other
//               parent can DISPUTE it (they can't silently decline a real bill).
//   request   — "would you split this?" Lands as 'pending'; the other parent
//               accepts (-> 'owed') or declines (-> 'declined'). Only counts if accepted.
//
// The tally nets two ledgers: expenses that are 'owed', minus payments recorded
// in `settlements`. Expenses stay 'owed' forever once agreed — a payment doesn't
// consume specific expenses, it just moves the running balance. This lets someone
// pay PART of what they owe: the balance simply shrinks by the amount paid.
const EXP_CATS = ['medical', 'school', 'clothing', 'activities', 'other'];

// owed_by's share of one expense, in cents (rounded to the nearest cent).
const shareCents = e => Math.round(e.amount_cents * e.split_pct / 100);

// Net balance between the two parents, from `viewer`'s perspective, in cents.
// Positive => the other parent owes viewer; negative => viewer owes them.
//   expense side: created_by paid, owed_by owes their share.
//   payment side: from_parent handed money to to_parent, reducing what from_parent owed.
function balanceFor(viewer) {
  const other = otherParent(viewer);
  const exp = db.prepare("SELECT * FROM expenses WHERE status='owed'").all();
  let net = 0;
  for (const e of exp) {
    const share = shareCents(e);
    if (e.created_by === viewer) net += share;       // they owe you their share
    else if (e.owed_by === viewer) net -= share;     // you owe them your share
  }
  // Payments: money the other paid you REDUCES what they owe (net down);
  // money you paid them reduces what you owe (net up toward zero / positive).
  const pays = db.prepare("SELECT * FROM settlements").all();
  for (const p of pays) {
    if (p.from_parent === other && p.to_parent === viewer) net -= p.amount_cents; // they paid you
    else if (p.from_parent === viewer && p.to_parent === other) net += p.amount_cents; // you paid them
  }
  return net;
}

app.get('/api/expenses', auth, parentOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC').all();
  res.json({
    me: req.parentId,
    expenses: rows,
    balance_cents: balanceFor(req.parentId),
    settlements: db.prepare('SELECT * FROM settlements ORDER BY id DESC LIMIT 20').all()
  });
});

app.post('/api/expenses', auth, parentOnly, (req, res) => {
  const { amount_cents, split_pct, description, category, kid_id, date, type } = req.body || {};
  const cents = Math.round(Number(amount_cents));
  if (!Number.isFinite(cents) || cents <= 0)
    return res.status(400).json({ error: 'Enter an amount greater than zero' });
  if (!description || !description.trim())
    return res.status(400).json({ error: 'Add a short description' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    return res.status(400).json({ error: 'A date is required' });
  if (type !== 'necessity' && type !== 'request')
    return res.status(400).json({ error: 'Pick necessity or request' });
  let pct = split_pct == null ? 50 : Math.round(Number(split_pct));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100)
    return res.status(400).json({ error: 'Split must be between 0 and 100%' });
  const other = otherParent(req.parentId);
  if (!other) return res.status(400).json({ error: 'No other parent configured' });
  const cat = EXP_CATS.includes(category) ? category : 'other';
  const status = type === 'necessity' ? 'owed' : 'pending';

  const r = db.prepare(`INSERT INTO expenses
    (created_by, owed_by, amount_cents, split_pct, description, category, kid_id, date, type, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.parentId, other, cents, pct, description.trim(), cat, kid_id || null, date, type, status, now());

  const addr = mailTo(other);
  if (addr) mail.expenseLogged({
    to: addr, actor: pName(req.parentId), type,
    item: { description: description.trim(), amount_cents: cents, split_pct: pct, date, category: cat },
    kid: kidName(kid_id), share_cents: Math.round(cents * pct / 100)
  });

  res.json({ id: r.lastInsertRowid, status });
});

// The owed_by parent responds to a REQUEST (accept/decline) or disputes a NECESSITY.
app.post('/api/expenses/:id/respond', auth, parentOnly, (req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.owed_by !== req.parentId)
    return res.status(403).json({ error: "This isn't yours to answer" });
  const action = req.body?.action; // accept | decline | dispute
  let next;
  if (e.type === 'request' && e.status === 'pending') {
    if (action === 'accept') next = 'owed';
    else if (action === 'decline') next = 'declined';
    else return res.status(400).json({ error: 'Accept or decline this request' });
  } else if (e.type === 'necessity' && e.status === 'owed') {
    if (action === 'dispute') next = 'disputed';
    else return res.status(400).json({ error: 'A necessity can only be disputed' });
  } else {
    return res.status(400).json({ error: 'This can no longer be changed' });
  }
  db.prepare('UPDATE expenses SET status=?, responded_at=? WHERE id=?').run(next, now(), e.id);

  const addr = mailTo(e.created_by);
  if (addr) mail.expenseAnswered({
    to: addr, actor: pName(req.parentId), action, next,
    item: e, share_cents: shareCents(e)
  });
  res.json({ ok: true, status: next });
});

// Creator resolves a disputed necessity: withdraw it, or re-assert it back to owed.
app.post('/api/expenses/:id/resolve', auth, parentOnly, (req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.created_by !== req.parentId)
    return res.status(403).json({ error: 'Only the person who logged it can resolve a dispute' });
  if (e.status !== 'disputed') return res.status(400).json({ error: 'This isn\u2019t disputed' });
  const action = req.body?.action; // withdraw | reassert
  if (action === 'withdraw') {
    db.prepare("UPDATE expenses SET status='declined', responded_at=? WHERE id=?").run(now(), e.id);
  } else if (action === 'reassert') {
    db.prepare("UPDATE expenses SET status='owed', responded_at=? WHERE id=?").run(now(), e.id);
  } else {
    return res.status(400).json({ error: 'Withdraw it or put it back' });
  }
  res.json({ ok: true });
});

// Edit / delete an expense you logged.
app.delete('/api/expenses/:id', auth, parentOnly, (req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.created_by !== req.parentId)
    return res.status(403).json({ error: 'Only the person who logged it can remove it' });
  db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

// Record a payment (full OR partial). The balance is a running tab, so a payment
// just moves it toward zero by `amount_cents` — you can pay $30 against a $50 debt
// and $20 stays owed. Direction is inferred from who currently owes whom, but the
// payer is always the one recording it (you mark what you handed over / received).
app.post('/api/expenses/settle', auth, parentOnly, (req, res) => {
  const other = otherParent(req.parentId);
  if (!other) return res.status(400).json({ error: 'No other parent configured' });
  const bal = balanceFor(req.parentId);           // + => other owes me; - => I owe other
  if (bal === 0) return res.status(400).json({ error: 'Nothing to settle — you\u2019re square' });

  // Who is paying whom is set by the sign of the balance. The debtor pays the creditor.
  const from = bal > 0 ? other : req.parentId;     // debtor
  const to   = bal > 0 ? req.parentId : other;     // creditor
  const outstanding = Math.abs(bal);

  // Amount: default to the full outstanding balance; allow a smaller partial amount.
  let amt = req.body?.amount_cents == null ? outstanding : Math.round(Number(req.body.amount_cents));
  if (!Number.isFinite(amt) || amt <= 0)
    return res.status(400).json({ error: 'Enter an amount greater than zero' });
  if (amt > outstanding)
    return res.status(400).json({ error: `That's more than the ${(outstanding/100).toFixed(2)} owed. Enter up to that.` });

  db.prepare('INSERT INTO settlements (from_parent, to_parent, amount_cents, note, created_at) VALUES (?,?,?,?,?)')
    .run(from, to, amt, (req.body?.note || '').trim() || null, now());

  const remaining = outstanding - amt;
  const addr = mailTo(other);
  if (addr) mail.expenseSettled({
    to: addr, actor: pName(req.parentId),
    from_name: pName(from), to_name: pName(to),
    amount_cents: amt, remaining_cents: remaining,
    note: (req.body?.note || '').trim() || null
  });
  res.json({ ok: true, paid_cents: amt, remaining_cents: remaining });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Co-parent calendar running on :${PORT}, data in ${DATA_DIR}`));
