const assert = require('assert');
const { computeDiff } = require('../src/dedupe.js');
const settings = { masterCalendarId: 'master@group.calendar.google.com' };
const ev = (source, title, start, end, extra = {}) => ({ source, prefix: '', title, location: '', description: '', allDay: false, start, end, ...extra });
const S = '2026-12-01T09:00:00.000Z', E = '2026-12-01T10:00:00.000Z';

// same meeting in two calendars (title case/whitespace differs) -> one create, first source wins
let d = computeDiff([
  { events: [ev('A', 'Team  Sync', S, E)] },
  { events: [ev('B', 'team sync', S, E), ev('B', 'Other', S, E)] },
], [], settings, 0);
assert.strictEqual(d.length, 2);
assert(d.every(x => x.action === 'create'));
assert(d.find(x => x.body.summary === 'Team  Sync').body.description.includes('source: A'));

// idempotent: feeding the created events back as master yields no writes
const master = d.map(x => ({ id: x.id, extendedProperties: x.body.extendedProperties }));
assert.strictEqual(computeDiff([{ events: [ev('A', 'Team  Sync', S, E)] }, { events: [ev('B', 'Other', S, E)] }], master, settings, 0).length, 0);

// removed upstream -> delete; but not when a source errored or feed is empty
const gone = computeDiff([{ events: [ev('A', 'Team  Sync', S, E)] }], master, settings, 0);
assert.deepStrictEqual(gone.map(x => x.action), ['delete']);
assert.strictEqual(computeDiff([{ events: [ev('A', 'Team  Sync', S, E)] }], master, settings, 1).length, 0);
assert.strictEqual(computeDiff([], master, settings, 0).length, 0);

// changed location -> update
const upd = computeDiff([{ events: [ev('A', 'Team  Sync', S, E, { location: 'Room 1' })] }], master, settings, 0);
assert.strictEqual(upd[0].action, 'update');

// all-day uses date fields; ids are valid Google ids [a-v0-9]
const ad = computeDiff([{ events: [ev('A', 'Holiday', null, null, { allDay: true, startDate: '2026-12-25', endDate: '2026-12-26', start: 'x', end: 'y' })] }], [], settings, 0);
assert.deepStrictEqual(ad[0].body.start, { date: '2026-12-25' });
assert(/^[a-v0-9]{5,}$/.test(ad[0].id));
console.log('dedupe tests passed');
