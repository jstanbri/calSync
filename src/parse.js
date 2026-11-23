// n8n Code node — "Parse ICS", mode: Run Once for Each Item.
// Input: HTTP Request output (ICS text in $json.data) paired with the "Load Config" item.
// Output: one item per event occurrence inside the window, or an error marker.
// Needs NODE_FUNCTION_ALLOW_EXTERNAL=ical.js
const ICAL = require('ical.js');
const cfg = $('Load Config').item.json;
const { daysBack, daysForward } = cfg.settings;
const src = cfg.source;

if ($json.error || typeof $json.data !== 'string' || !$json.data.includes('BEGIN:VCALENDAR')) {
  return { json: { _kind: 'error', source: src.name, message: String($json.error?.message || 'no ICS data') } };
}

const now = Date.now();
const winStart = now - daysBack * 864e5;
const winEnd = now + daysForward * 864e5;

const root = new ICAL.Component(ICAL.parse($json.data));
root.getAllSubcomponents('vtimezone').forEach(tz => {
  try { ICAL.TimezoneService.register(tz); } catch (e) {}
});

const out = [];
const push = (ev, startT, endT) => {
  const allDay = startT.isDate;
  const s = startT.toJSDate();
  const e = endT.toJSDate();
  if (e.getTime() < winStart || s.getTime() > winEnd) return;
  out.push({ json: {
    _kind: 'event',
    source: src.name,
    prefix: src.prefix || '',
    title: ev.summary || '(no title)',
    location: ev.location || '',
    description: ev.description || '',
    allDay,
    start: s.toISOString(),
    end: e.toISOString(),
    startDate: allDay ? startT.toString() : null,
    endDate: allDay ? endT.toString() : null,
  } });
};

const masters = root.getAllSubcomponents('vevent').filter(v => !v.hasProperty('recurrence-id'));
const overrides = root.getAllSubcomponents('vevent').filter(v => v.hasProperty('recurrence-id'));
const overridden = new Set(overrides.map(v => v.getFirstPropertyValue('uid') + '|' + v.getFirstPropertyValue('recurrence-id').toJSDate().getTime()));

for (const comp of masters) {
  const ev = new ICAL.Event(comp);
  if (comp.getFirstPropertyValue('status') === 'CANCELLED') continue;
  if (ev.isRecurring()) {
    const it = ev.iterator();
    let next, guard = 0;
    while ((next = it.next()) && guard++ < 2000) {
      if (next.toJSDate().getTime() > winEnd) break;
      if (overridden.has(ev.uid + '|' + next.toJSDate().getTime())) continue;
      const d = ev.getOccurrenceDetails(next);
      push(ev, d.startDate, d.endDate);
    }
  } else {
    push(ev, ev.startDate, ev.endDate);
  }
}
for (const comp of overrides) {
  if (comp.getFirstPropertyValue('status') === 'CANCELLED') continue;
  const ev = new ICAL.Event(comp);
  push(ev, ev.startDate, ev.endDate);
}

// Run-once-for-each-item must return one item; wrap list so Dedupe can flatten.
return { json: { _kind: 'batch', source: src.name, events: out.map(o => o.json) } };
