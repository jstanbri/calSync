// n8n Code node — "Dedupe & Diff", mode: Run Once for All Items.
// Input (merged): per-source batches from "Parse ICS" ({_kind:'batch', events:[...]})
//   plus one item from "Get Master Events" ({items:[...]} from the Google Calendar API).
// Output: one item per write needed: {action:'create'|'update'|'delete', calendarId, id, body?}

// cyrb53 string hash (two seeds -> ~28 hex chars). Google event ids allow [a-v0-9], hex is a subset.
function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
const hash = s => cyrb53(s, 1) + cyrb53(s, 2);
const norm = t => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

function computeDiff(batches, masterItems, settings, sourceErrors) {
  // 1. dedupe — first source listed wins
  const desired = new Map();
  const seen = new Set();
  for (const b of batches) {
    for (const e of b.events) {
      const key = norm(e.title) + '|' + (e.allDay ? e.startDate + '/' + e.endDate : e.start + '/' + e.end);
      if (seen.has(key)) continue;
      seen.add(key);
      const id = 'cs' + hash(key);
      const body = {
        id,
        summary: (e.prefix || '') + e.title,
        location: e.location || undefined,
        description: ((e.description || '') + '\n\n[calSync source: ' + e.source + ']').trim(),
        start: e.allDay ? { date: e.startDate } : { dateTime: e.start },
        end: e.allDay ? { date: e.endDate } : { dateTime: e.end },
      };
      body.extendedProperties = { private: { calSync: '1', contentHash: hash(JSON.stringify(body)) } };
      desired.set(id, body);
    }
  }

  // 2. diff against what calSync previously wrote to the master
  const existing = new Map(masterItems.map(m => [m.id, m]));
  const out = [];
  const calendarId = settings.masterCalendarId;
  for (const [id, body] of desired) {
    const ex = existing.get(id);
    if (!ex) out.push({ action: 'create', calendarId, id, body });
    else if (ex.extendedProperties?.private?.contentHash !== body.extendedProperties.private.contentHash || ex.status === 'cancelled')
      out.push({ action: 'update', calendarId, id, body });
  }
  // 3. deletions — skipped if any source failed or nothing came back (avoid wiping master on an outage)
  if (sourceErrors === 0 && desired.size > 0) {
    for (const id of existing.keys()) if (!desired.has(id)) out.push({ action: 'delete', calendarId, id });
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { computeDiff, hash, norm };

if (typeof $input !== 'undefined') {
  const settings = $('Load Config').first().json.settings;
  const all = $input.all().map(i => i.json);
  const batches = all.filter(j => j._kind === 'batch');
  const sourceErrors = all.filter(j => j._kind === 'error').length;
  const masterItems = all.filter(j => Array.isArray(j.items)).flatMap(j => j.items);
  const diff = computeDiff(batches, masterItems, settings, sourceErrors);
  if (diff.length === 0) return [{ json: { action: 'noop', sourceErrors } }];
  return diff.map(d => ({ json: d }));
}
