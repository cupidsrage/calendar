const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/holidays.js');

const FATHER = 1, MOTHER = 2;
const byKey = (year, breaks) => Object.fromEntries(H.holidayPeriods(year, breaks).map(p => [p.key, p]));

test('holiday dates and times follow the order', () => {
  assert.equal(H.easterSunday(2026), '2026-04-05');
  assert.equal(H.easterSunday(2027), '2027-03-28');
  const h = byKey(2026, [{ year: 2026, starts: '2026-12-19', resumes: '2027-01-05' }]);
  assert.deepEqual([h.easter.start, h.easter.end], ['2026-04-03T18:00', '2026-04-05T18:00']);
  assert.deepEqual([h.mothersday.start, h.mothersday.end], ['2026-05-08T18:00', '2026-05-10T18:00']);
  assert.deepEqual([h.fathersday.start, h.fathersday.end], ['2026-06-19T18:00', '2026-06-21T18:00']);
  assert.deepEqual([h.memorial.start, h.memorial.end], ['2026-05-22T18:00', '2026-05-25T18:00']);
  assert.deepEqual([h.july4.start, h.july4.end], ['2026-07-04T10:00', '2026-07-05T10:00']);
  assert.deepEqual([h.labor.start, h.labor.end], ['2026-09-04T18:00', '2026-09-07T18:00']);
  assert.deepEqual([h.thanksgiving.start, h.thanksgiving.end], ['2026-11-25T18:00', '2026-11-29T18:00']);
  assert.deepEqual([h.xmas1.start, h.xmas1.end], ['2026-12-19T18:00', '2026-12-24T18:00']);
  assert.deepEqual([h.xmas2.start, h.xmas2.end], ['2026-12-24T18:00', '2027-01-04T18:00']);
  assert.equal(byKey(2026, []).xmas1, undefined, 'no Christmas split without school dates');
});

test('even/odd year assignments match the FATHER / MOTHER columns', () => {
  const expect = {
    2026: { easter: 'father', mothersday: 'mother', fathersday: 'father', memorial: 'father', july4: 'mother',
            labor: 'father', thanksgiving: 'mother', xmas1: 'father', xmas2: 'mother' },
    2027: { easter: 'mother', mothersday: 'mother', fathersday: 'father', memorial: 'mother', july4: 'father',
            labor: 'mother', thanksgiving: 'father', xmas1: 'mother', xmas2: 'father' }
  };
  for (const [y, roles] of Object.entries(expect))
    for (const [k, role] of Object.entries(roles)) assert.equal(H.roleFor(k, +y), role, `${k} ${y}`);
});

test('holidays supersede the rotation with timed handovers', () => {
  const opts = { baseFor: () => MOTHER, fatherId: FATHER, motherId: MOTHER, breaks: [] };
  // Easter 2026 is Father's: Fri evening handover, all Saturday, back Sunday 6 PM.
  let d = H.custodyDay('2026-04-03', opts);
  assert.equal(d.morning, MOTHER); assert.equal(d.pid, FATHER);
  assert.deepEqual(d.exchanges, [{ time: '18:00', from: MOTHER, to: FATHER }]);
  assert.equal(H.custodyDay('2026-04-04', opts).pid, FATHER);
  d = H.custodyDay('2026-04-05', opts);
  assert.equal(d.morning, FATHER); assert.equal(d.pid, MOTHER);
  // Same-parent holiday: no handover, holiday still labelled.
  d = H.custodyDay('2026-05-09', opts);
  assert.equal(d.pid, MOTHER); assert.equal(d.exchanges.length, 0); assert.equal(d.holidays[0].key, 'mothersday');
  // Christmas second half crosses New Year and ends the day before school.
  const xopts = { ...opts, baseFor: () => FATHER, breaks: [{ year: 2026, starts: '2026-12-19', resumes: '2027-01-05' }] };
  assert.equal(H.custodyDay('2026-12-23', xopts).pid, FATHER);
  d = H.custodyDay('2026-12-24', xopts);
  assert.deepEqual(d.exchanges, [{ time: '18:00', from: FATHER, to: MOTHER }]);
  assert.equal(H.custodyDay('2027-01-02', xopts).pid, MOTHER);
  d = H.custodyDay('2027-01-04', xopts);
  assert.equal(d.morning, MOTHER); assert.equal(d.pid, FATHER);
  // Off when no father is designated.
  assert.equal(H.custodyDay('2026-04-04', { ...opts, fatherId: null, motherId: null }).pid, MOTHER);
});
