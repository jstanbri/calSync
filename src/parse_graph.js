// n8n Code node — "Parse Graph", mode: Run Once for Each Item.
// Input: one page of /me/calendarView (with Prefer: outlook.timezone="UTC"), paired with its "Load Config" item.
// Output: same {_kind:'batch'|'error'} shape as "Parse ICS".
const src = $('Load Config').item.json.source;

if ($json.error || !Array.isArray($json.value)) {
  return { json: { _kind: 'error', source: src.name, message: String($json.error?.message || $json.error || 'no Graph data') } };
}

const utc = s => new Date(String(s).replace(/(\.\d{3})\d*$/, '$1') + 'Z').toISOString();
const events = $json.value
  .filter(e => !e.isCancelled)
  .map(e => {
    const allDay = !!e.isAllDay;
    return {
      _kind: 'event',
      source: src.name,
      prefix: src.prefix || '',
      title: e.subject || '(no title)',
      location: e.location?.displayName || '',
      description: e.bodyPreview || '',
      allDay,
      start: utc(e.start.dateTime),
      end: utc(e.end.dateTime),
      startDate: allDay ? e.start.dateTime.slice(0, 10) : null,
      endDate: allDay ? e.end.dateTime.slice(0, 10) : null,
    };
  });

return { json: { _kind: 'batch', source: src.name, events } };
