/* Holiday visitation schedule (custody order, paragraph 36).
 *
 * Holidays always supersede the regular week-on/week-off rotation. Each holiday is a
 * timed period (e.g. 6:00 PM Friday until 6:00 PM Sunday) that belongs to the father or
 * the mother depending on whether the year is even or odd. Times are compared as local
 * 'YYYY-MM-DDTHH:MM' strings so nothing here depends on the device's time zone.
 *
 * Loaded by the browser as a plain script (window.Holidays) and by the tests via require().
 */
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const ymd = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  };
  const addDays = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); return ymd(y, m, d + n); };
  const dow = ds => { const [y, m, d] = ds.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  // n-th weekday (0=Sun..6=Sat) of a month; n = -1 means the last one.
  function nthWeekday(y, m, weekday, n) {
    if (n > 0) {
      const first = ymd(y, m, 1);
      return addDays(first, (weekday - dow(first) + 7) % 7 + (n - 1) * 7);
    }
    const last = ymd(y, m + 1, 0);
    return addDays(last, -((dow(last) - weekday + 7) % 7));
  }
  // Western (Gregorian) Easter Sunday — anonymous Gregorian algorithm.
  function easterSunday(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return ymd(y, month, day);
  }

  // Whose holiday it is: 'even' = father in even years / mother in odd years, and so on.
  // Straight from the order's FATHER / MOTHER columns.
  const RULES = {
    easter:      { name: 'Easter',                   icon: '🐣', father: 'even' },
    mothersday:  { name: "Mother's Day",             icon: '💐', always: 'mother' },
    fathersday:  { name: "Father's Day",             icon: '👔', always: 'father' },
    memorial:    { name: 'Memorial Day',             icon: '🇺🇸', father: 'even' },
    july4:       { name: 'Fourth of July',           icon: '🎆', father: 'odd' },
    labor:       { name: 'Labor Day',                icon: '🛠️', father: 'even' },
    thanksgiving:{ name: 'Thanksgiving',             icon: '🦃', father: 'odd' },
    xmas1:       { name: 'Christmas (first half)',   icon: '🎄', father: 'even' },
    xmas2:       { name: 'Christmas (second half)',  icon: '🎁', father: 'odd' }
  };
  function roleFor(key, year) {
    const r = RULES[key];
    if (r.always) return r.always;
    const even = year % 2 === 0;
    return (r.father === 'even') === even ? 'father' : 'mother';
  }

  // Every holiday period whose holiday falls in `year`. Christmas needs that year's
  // school break: { year, starts: day the school holiday begins, resumes: first day back }.
  // Without it the two Christmas halves can't be placed, so they're left out.
  function holidayPeriods(year, breaks) {
    const out = [];
    const add = (key, startDate, startTime, endDate, endTime) => out.push({
      key, year, name: RULES[key].name, icon: RULES[key].icon, role: roleFor(key, year),
      start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`
    });
    const easter = easterSunday(year);
    add('easter', addDays(easter, -2), '18:00', easter, '18:00');
    const mom = nthWeekday(year, 5, 0, 2);
    add('mothersday', addDays(mom, -2), '18:00', mom, '18:00');
    const dad = nthWeekday(year, 6, 0, 3);
    add('fathersday', addDays(dad, -2), '18:00', dad, '18:00');
    const memorial = nthWeekday(year, 5, 1, -1);
    add('memorial', addDays(memorial, -3), '18:00', memorial, '18:00');
    add('july4', ymd(year, 7, 4), '10:00', ymd(year, 7, 5), '10:00');
    const labor = nthWeekday(year, 9, 1, 1);
    add('labor', addDays(labor, -3), '18:00', labor, '18:00');
    const thanks = nthWeekday(year, 11, 4, 4);
    add('thanksgiving', addDays(thanks, -1), '18:00', addDays(thanks, 3), '18:00');
    const brk = (breaks || []).find(b => +b.year === year);
    if (brk) {
      const eve = ymd(year, 12, 24);
      if (brk.starts < eve) add('xmas1', brk.starts, '18:00', eve, '18:00');
      const lastDay = addDays(brk.resumes, -1);
      if (lastDay > eve) add('xmas2', eve, '18:00', lastDay, '18:00');
    }
    return out.sort((a, b) => a.start < b.start ? -1 : 1);
  }

  /* Custody for one calendar day.
   *   baseFor(ds)  -> parent id from the regular rotation (or null)
   *   fatherId / motherId, breaks -> holiday config (holidays are skipped if fatherId is unset)
   * Returns { pid, morning, exchanges:[{time,from,to}], holidays:[period + pid] }.
   * `pid` is who has the kids at the END of the day (overnight) — the same convention the
   * rotation uses, where an exchange day belongs to the incoming parent. */
  function custodyDay(ds, { baseFor, fatherId, motherId, breaks }) {
    const next = addDays(ds, 1);
    const dayStart = `${ds}T00:00`, dayEnd = `${next}T00:00`;
    const y = +ds.slice(0, 4);
    const periods = fatherId && motherId
      ? [y - 1, y].flatMap(yr => holidayPeriods(yr, breaks))
          .map(p => ({ ...p, pid: p.role === 'father' ? fatherId : motherId }))
      : [];
    const who = t => {
      const p = periods.find(p => p.start <= t && t < p.end);
      return p ? p.pid : baseFor(t.slice(0, 10));
    };
    const touching = periods.filter(p => p.start < dayEnd && p.end > dayStart);
    const cuts = [...new Set(touching.flatMap(p => [p.start, p.end]))]
      .filter(t => t > dayStart && t < dayEnd).sort();
    const morning = who(dayStart);
    let cur = morning;
    const exchanges = [];
    for (const t of cuts) {
      const nxt = who(t);
      if (nxt !== cur) { exchanges.push({ time: t.slice(11), from: cur, to: nxt }); cur = nxt; }
    }
    return { pid: cur, morning, exchanges, holidays: touching };
  }

  const api = { RULES, roleFor, easterSunday, nthWeekday, holidayPeriods, custodyDay, addDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Holidays = api;
})(typeof window !== 'undefined' ? window : globalThis);
