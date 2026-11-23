# calSync

An [n8n](https://n8n.io) workflow that pulls many calendar subscriptions once a day, removes duplicates, and writes the result into a single **master** Google Calendar.

Directed by James Stanbridge — written and prepared with Claude Code (Anthropic).

## How it works

```
Daily 05:00 ─► Load Config ─┬─► Fetch ICS (per source) ─► Parse ICS ─┐
                            └─► Get Master Events ───────────────────┴─► Combine ─► Dedupe & Diff ─► Create / Update / Delete
```

- **Sources** are ICS subscription URLs listed in `config/sources.json`. At least four are Microsoft 365 published calendars, plus one Google Calendar secret ICS address. Add or remove entries to scale up or down; no workflow edits are needed.
- **Dedupe key:** normalised title + start + end. The same meeting seen in two calendars is written once. The source listed first wins.
- **Master calendar:** a Google Calendar you own. calSync only touches events it created (tagged with a private extended property `calSync=1`), so anything you add to the master by hand is left alone.
- **Idempotent:** event ids are deterministic and content-hashed, so unchanged events are not rewritten. Events that disappear upstream are deleted from the master.
- **Safety:** if any source fails to fetch, or nothing comes back at all, deletions are skipped for that run so an outage cannot wipe the master.
- **Window:** `daysBack` (default 7) to `daysForward` (default 90). Recurring events are expanded inside the window.

## Prerequisites

| Requirement | Why |
|---|---|
| **n8n** (self-hosted, 1.x or later) | Runs the workflow. n8n Cloud will not work as-is because the Code nodes need an external module. |
| **`ical.js`** installed alongside n8n, with `NODE_FUNCTION_ALLOW_EXTERNAL=ical.js` | Parses ICS and expands recurring events. |
| **Google Calendar OAuth2 credential** in n8n | Reads and writes the master calendar. Create it under *Credentials → Google Calendar OAuth2 API*. |
| A **Google Calendar to use as master** | Create a dedicated one (not a source). Its calendar id goes in the config. |
| **ICS URL for each source** | M365: Outlook on the web → Settings → Calendar → Shared calendars → *Publish a calendar* → copy the ICS link. Google: Calendar settings → *Secret address in iCal format*. |
| Docker (optional) | For the quick start below and for running tests. |

M365 tenant admins can disable calendar publishing. If a tenant blocks it, that source needs a Microsoft Graph based node instead (see Roadmap).

ICS links are secrets: anyone with the link can read the calendar. `config/sources.json` is gitignored; never commit it.

## Quick start (Docker)

```bash
# 1. n8n with ical.js available
cat > Dockerfile <<'DOCKER'
FROM docker.n8n.io/n8nio/n8n
USER root
RUN cd /usr/local/lib/node_modules/n8n && npm install ical.js@2.1.0
USER node
DOCKER
docker build -t n8n-calsync .
docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n \
  -e NODE_FUNCTION_ALLOW_EXTERNAL=ical.js n8n-calsync

# 2. configure and build the workflow
cp config/sources.example.json config/sources.json   # edit URLs + masterCalendarId
python3 scripts/build_workflow.py                     # writes workflows/calsync.n8n.json
```

3. In n8n: *Workflows → Import from file* → `workflows/calsync.n8n.json`.
4. Open **Get Master Events**, **Create Event**, **Update Event**, **Delete Event** and select your Google Calendar credential.
5. Run once manually and check the master calendar, then activate the workflow.

> The Docker image path above can vary between n8n releases; adjust the `npm install` location if the build fails.

## Adding or removing a calendar

Edit `config/sources.json` (add an object, or set `"enabled": false`), re-run `python3 scripts/build_workflow.py`, and re-import. Or edit the `CONFIG` constant directly in the **Load Config** node. Removing a source removes its events from the master on the next run, unless they are also present in another source.

`prefix` is prepended to event titles so you can tell where an event came from (e.g. `[W1] `).

## Tests

```bash
docker run --rm -v "$PWD":/w -w /w node:22-alpine node tests/dedupe.test.js
docker run --rm -v "$PWD":/w -w /w node:22-alpine sh -c "cd /tmp && npm i ical.js@2.1.0 && NODE_PATH=/tmp/node_modules node /w/tests/parse.test.js"
```

## Status

The dedupe/diff logic and the ICS parser have unit tests that pass. The assembled workflow has **not yet been run end to end** inside n8n against live calendars; treat the first run as a trial against a throwaway master calendar.

## Known limitations

- Google Calendar API list is capped at 2,500 events in the window (no pagination yet).
- ICS feeds from M365 can lag by several hours, so the master is only as fresh as the upstream feed.
- Attendees, reminders, and meeting links are not copied; only title, time, location, and description.
- A master event edited by hand that calSync owns is overwritten when the source changes.

## Roadmap

- Microsoft Graph fallback for tenants that block ICS publishing
- "Busy only" mode per source (hide titles)
- Pagination for large windows
- Failure notification (email/Teams) when a source errors

## Project notes

Notes and project tracking live in Notion (calSync project page).

## Licence

MIT
