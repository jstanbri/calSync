const fs = require('fs'), assert = require('assert');
const fn = new Function('$', '$json', fs.readFileSync(__dirname + '/../src/parse_graph.js', 'utf8'));
const cfg = { source: { name: 'G', prefix: '[G] ' } };
const page = { value: [
  { subject: 'Standup', isAllDay: false, isCancelled: false, start: { dateTime: '2026-12-01T09:00:00.0000000' }, end: { dateTime: '2026-12-01T09:30:00.0000000' }, location: { displayName: 'Teams' }, bodyPreview: 'hi' },
  { subject: 'Holiday', isAllDay: true, isCancelled: false, start: { dateTime: '2026-12-25T00:00:00.0000000' }, end: { dateTime: '2026-12-26T00:00:00.0000000' }, location: {}, bodyPreview: '' },
  { subject: 'Cancelled', isCancelled: true, start: { dateTime: '2026-12-02T09:00:00.0000000' }, end: { dateTime: '2026-12-02T10:00:00.0000000' } },
] };
const out = fn(() => ({ item: { json: cfg } }), page).json;
assert.strictEqual(out._kind, 'batch');
assert.strictEqual(out.events.length, 2);
assert.strictEqual(out.events[0].start, '2026-12-01T09:00:00.000Z');
assert.strictEqual(out.events[0].location, 'Teams');
assert.deepStrictEqual([out.events[1].allDay, out.events[1].startDate, out.events[1].endDate], [true, '2026-12-25', '2026-12-26']);
assert.strictEqual(fn(() => ({ item: { json: cfg } }), { error: { message: 'boom' } }).json._kind, 'error');
console.log('graph parse tests passed');
