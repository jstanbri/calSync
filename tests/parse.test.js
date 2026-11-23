// Harness: runs src/parse.js the way n8n would (needs `npm i ical.js`; see README "Tests").
const fs = require('fs'), assert = require('assert');
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:a
SUMMARY:Weekly standup
DTSTART:20260101T090000Z
DTEND:20260101T093000Z
RRULE:FREQ=WEEKLY;COUNT=400
END:VEVENT
BEGIN:VEVENT
UID:b
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261225
DTEND;VALUE=DATE:20261226
END:VEVENT
END:VCALENDAR`;
const fn = new Function('require', '$', '$json', fs.readFileSync(__dirname + '/../src/parse.js', 'utf8'));
const cfg = { settings: { daysBack: 7, daysForward: 90 }, source: { name: 'T', prefix: '[T] ' } };
// window is relative to "now"; freeze Date.now to 2026-11-23 for determinism
const real = Date.now; Date.now = () => Date.parse('2026-11-23T00:00:00Z');
const out = fn(require, () => ({ item: { json: cfg } }), { data: ics });
Date.now = real;
const evs = out.json.events;
const st = evs.filter(e => e.title === 'Weekly standup'); assert(st.length >= 13 && st.length <= 15, 'standups: ' + st.length);
assert(evs.some(e => e.allDay && e.startDate === '2026-12-25'));
console.log('parse test passed:', evs.length, 'events');
