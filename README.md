# calSync

An [n8n](https://n8n.io) workflow that pulls many calendar subscriptions once a day, removes duplicates, and writes the result into a single **master** Google Calendar.

Directed by James Stanbridge — written and prepared with Claude Code (Anthropic).

## How it works

```
Daily 05:00 ─► Load Config ─┬─► Fetch ICS (per source) ─► Parse ICS ─┐
                            └─► Get Master Events ───────────────────┴─► Combine ─► Dedupe & Diff ─► Create / Update / Delete
```

- **Sources** are listed in `config/sources.json`: ICS subscription URLs (`"type": "ics"`) or Microsoft Graph mailboxes (`"type": "graph"`). At least four are Microsoft 365 published calendars, plus one Google Calendar secret ICS address. Add or remove entries to scale up or down; no workflow edits are needed.
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
| **Microsoft Outlook OAuth2 credential** (only for `graph` sources) | Reads a mailbox that cannot publish ICS. |
| Docker (optional) | For the quick start below and for running tests. |

M365 tenant admins can disable calendar publishing. For those mailboxes use a `"type": "graph"` source instead (see below). It reads the calendar through Microsoft Graph and needs no ICS link.

### Microsoft Graph sources (when ICS publishing is blocked)

1. In the Entra admin centre (portal.azure.com → Microsoft Entra ID → App registrations) create an app registration.
   - Supported account types: this organisational directory only.
   - Redirect URI (Web): `http://localhost:5678/rest/oauth2-credential/callback`
   - API permissions → Microsoft Graph → *Delegated* → `Calendars.Read` (plus `offline_access`). Grant admin consent if your tenant requires it.
   - Certificates & secrets → new client secret (copy the **value** immediately).
2. In n8n create a **Microsoft Outlook OAuth2 API** credential with that client id and secret. If the credential offers *Custom Scopes*, set `openid offline_access Calendars.Read` so calSync only asks to read calendars. Sign in as the mailbox owner.
3. Add `{ "name": "...", "type": "graph", "prefix": "[X] ", "enabled": true }` to `config/sources.json` (no URL), rebuild with `CALSYNC_MS_CRED_ID=<credential id>`, or select the credential on the **Fetch Graph** node.

The workflow has **one** Graph branch, so it supports one Graph mailbox (the one the credential signs in as). More than one needs the Fetch Graph and Parse Graph nodes duplicated, each with its own credential.

ICS links are secrets: anyone with the link can read the calendar. `config/sources.json` is gitignored; never commit it.

## Quick start (Docker)

```bash
# 1. build n8n with ical.js baked in, and run it
docker build -t n8n-calsync -f docker/Dockerfile docker/
docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8n-calsync
# editor now at http://localhost:5678

# 2. configure and build the workflow
cp config/sources.example.json config/sources.json   # edit URLs + masterCalendarId
python3 scripts/build_workflow.py                     # writes build/calsync.n8n.json (gitignored, contains your URLs)
# optional: CALSYNC_GCAL_CRED_ID=<n8n credential id> python3 scripts/build_workflow.py   # pre-links the Google credential
# (python3 scripts/build_workflow.py --template rebuilds the tracked placeholder version)
```

3. In n8n: *Workflows → Import from file* → `build/calsync.n8n.json`.
4. Open **Get Master Events**, **Create Event**, **Update Event**, **Delete Event** and select your Google Calendar credential.
5. Run once manually and check the master calendar, then activate the workflow.

> `docker/Dockerfile` installs `ical.js` into its own folder (`/opt/calsync`) and sets `NODE_PATH` and `NODE_FUNCTION_ALLOW_EXTERNAL`, rather than touching n8n's install tree, which breaks `npm install` on current images. It pulls `n8nio/n8n` from Docker Hub; `docker.n8n.io` rate-limits (HTTP 429) at times. Verified with n8n 2.48.8: image builds, `require('ical.js')` works in a Code node, and the workflow imports.

## Adding or removing a calendar

Edit `config/sources.json` (add an object, or set `"enabled": false`), re-run `python3 scripts/build_workflow.py`, and re-import. Or edit the `CONFIG` constant directly in the **Load Config** node. Removing a source removes its events from the master on the next run, unless they are also present in another source.

`prefix` is prepended to event titles so you can tell where an event came from (e.g. `[W1] `).

## Tests

```bash
docker run --rm -v "$PWD":/w -w /w node:22-alpine sh -c "node tests/dedupe.test.js && node tests/parse_graph.test.js"
docker run --rm -v "$PWD":/w -w /w node:22-alpine sh -c "cd /tmp && npm i ical.js@2.1.0 && NODE_PATH=/tmp/node_modules node /w/tests/parse.test.js"
```

## Status

The dedupe/diff logic and the ICS parser have unit tests that pass. The full workflow has been run end to end in n8n 2.48.8 against one live M365 feed and a dedicated master calendar: first run created the events, a re-run created only what was missing, and a third run was a no-op. Only one ICS source has been tested live so far; multi-source dedupe and the Graph source have only unit tests.

To run it from the CLI: `docker exec -e N8N_RUNNERS_BROKER_PORT=5680 n8n n8n execute --id=calSyncWorkflow01` (the workflow has a **Manual Run** trigger as well as the daily schedule).

## Known limitations

- Google Calendar API list is capped at 2,500 events in the window (no pagination yet).
- ICS feeds from M365 can lag by several hours, so the master is only as fresh as the upstream feed.
- Attendees, reminders, and meeting links are not copied; only title, time, location, and description.
- A master event edited by hand that calSync owns is overwritten when the source changes.
- Event descriptions are copied verbatim, which can include Teams join links and meeting passcodes. Anyone with access to the master can see them (a "busy only" / strip-description option is on the roadmap).

## Roadmap

- Several Microsoft Graph mailboxes in one workflow
- "Busy only" mode per source (hide titles)
- Pagination for large windows
- Failure notification (email/Teams) when a source errors

## Project notes

Notes and project tracking live in Notion (calSync project page).

## Licence

MIT
