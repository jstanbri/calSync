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
- **Rate limits:** writes are paced. A write that hits a rate limit, a 5xx or a dropped connection is retried on its own after 10, 20, 40, 60 and 60 seconds. A create that returns 409 (id already exists) becomes an update, and deleting an event that is already gone counts as done. Any other error, or running out of retries, fails the run.
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
docker volume create n8n_data
docker compose up -d --build
# editor now at http://localhost:5678

# 2. configure and build the workflow
cp config/sources.example.json config/sources.json   # edit URLs + masterCalendarId
python3 scripts/build_workflow.py                     # writes build/calsync.n8n.json (gitignored, contains your URLs)
# optional: CALSYNC_GCAL_CRED_ID=<n8n credential id> python3 scripts/build_workflow.py   # pre-links the Google credential
# (python3 scripts/build_workflow.py --template rebuilds the tracked placeholder version)
```

3. In n8n: *Workflows → Import from file* → `build/calsync.n8n.json`.
4. Open **Get Master Events**, **Create Event**, **Update Event**, **Delete Event** and select your Google Calendar credential.
5. Run once manually and check the master calendar, then publish (activate) the workflow.

The schedule is 05:00 `Europe/London` (set in the workflow settings), so it follows GMT/BST.

For ICS sources from Google, use the *Secret address in iCal format* (it ends in `/basic.ics`). A share link containing `?cid=` returns a web page and the source fails.

> `docker/Dockerfile` installs `ical.js` into its own folder (`/opt/calsync`) and sets `NODE_PATH` and `NODE_FUNCTION_ALLOW_EXTERNAL`, rather than touching n8n's install tree, which breaks `npm install` on current images. It pulls `n8nio/n8n` from Docker Hub; `docker.n8n.io` rate-limits (HTTP 429) at times. Verified with n8n 2.48.8: image builds, `require('ical.js')` works in a Code node, and the workflow imports.

## Deploying to a NAS (always-on Docker host)

The NAS needs Docker with Compose. Python is only needed on the machine that builds the workflow, which can stay your laptop. These commands assume SSH access to the NAS and permission to run `docker` there (some NAS systems need `sudo`).

**Run only one active instance.** Two instances writing to the same master calendar can collide, and one with older config can undo the other's changes.

### Option A: move the existing n8n data (recommended)

This keeps the n8n login, the Google credential and its id, and the published workflow. The data volume holds the database and the key that decrypts the credentials, so treat the archive as a secret.

```bash
# laptop: stop n8n (leave it stopped), then archive the volume outside the repo
docker stop n8n
docker run --rm -v n8n_data:/data:ro -v "$HOME":/backup alpine tar czf /backup/n8n_data.tgz -C /data .
scp ~/n8n_data.tgz user@nas:~/

# NAS: get the repo (git clone, or copy docker-compose.yml and docker/ into one folder)
docker volume create n8n_data
docker run --rm -v n8n_data:/data -v "$HOME":/backup alpine tar xzf /backup/n8n_data.tgz -C /data
docker compose up -d --build

# then delete n8n_data.tgz on both machines
```

The workflow is already published in the copied data, so the NAS runs it at the next 05:00. If you later start the laptop container again, unpublish its copy first or don't start it at all. If the laptop container was created with a restart policy, turn it off: `docker update --restart=no n8n`.

### Option B: fresh install

On the NAS run `docker volume create n8n_data && docker compose up -d --build`, create the n8n owner account, add the Google credential (see below), then follow *Updating the NAS*.

### Connecting or reconnecting Google

Google does not accept a plain-http redirect address on a LAN IP, so do the OAuth sign-in through an SSH tunnel. Stop any local n8n first so port 5678 is free.

```bash
ssh -L 5678:localhost:5678 user@nas
```

Open `http://localhost:5678` and connect the credential. The redirect URI stays `http://localhost:5678/rest/oauth2-credential/callback`. The tunnel is only needed while signing in. Some NAS systems disable SSH port forwarding by default.

In Google Cloud, check the OAuth consent screen's publishing status. For an external app left in **Testing**, Google expires refresh tokens after 7 days, and the unattended sync would stop.

### Updating the NAS

Use this after changing sources or workflow code. `<id>` is the Google credential id on the NAS (the last part of its URL in the n8n editor). Without it the imported workflow has no credential.

```bash
# laptop
CALSYNC_GCAL_CRED_ID=<id> python3 scripts/build_workflow.py
scp build/calsync.n8n.json user@nas:~/

# NAS: importing unpublishes the workflow, so publish again and restart
docker cp ~/calsync.n8n.json n8n:/tmp/calsync.json
docker exec n8n n8n import:workflow --input=/tmp/calsync.json
docker exec n8n n8n publish:workflow --id=calSyncWorkflow01
docker restart n8n
docker exec -u root n8n rm /tmp/calsync.json
rm ~/calsync.n8n.json          # contains your secret ICS URLs
```

### Checking it works

- `docker exec n8n n8n list:workflow --active=true` should list `calSyncWorkflow01`.
- After 05:00, check **Executions** in the n8n editor (`http://<nas-ip>:5678`). A green run can still have a failed source: open **Parse ICS** and look for `_kind: error`. While any source is failing, nothing is deleted from the master.
- There are no failure notifications yet, so check now and then.

The compose file serves plain http for LAN use. Don't expose port 5678 to the internet. Back up the `n8n_data` volume.

## Adding or removing a calendar

Edit `config/sources.json` (add an object, or set `"enabled": false`), re-run `python3 scripts/build_workflow.py`, and re-import (on a NAS, see *Updating the NAS*). Or edit the `CONFIG` constant directly in the **Load Config** node. Removing a source removes its events from the master on the next run, unless they are also present in another source.

`prefix` is prepended to event titles so you can tell where an event came from (e.g. `[W1] `).

## Tests

```bash
docker run --rm -v "$PWD":/w -w /w node:22-alpine sh -c "node tests/dedupe.test.js && node tests/parse_graph.test.js && node tests/write_error.test.js"
docker run --rm -v "$PWD":/w -w /w node:22-alpine sh -c "cd /tmp && npm i ical.js@2.1.0 && NODE_PATH=/tmp/node_modules node /w/tests/parse.test.js"
```

## Status

The dedupe/diff logic, both parsers and the write-error classifier have unit tests that pass. In n8n 2.48.8 the workflow has run end to end against three live M365 feeds and one Google feed with a dedicated master calendar: 242 events from 243 source events (one duplicate), and a re-run was a no-op. The retry paths (403 and 429 rate limits, 409, 410, 401) were run in n8n against a fake calendar API, not triggered again on Google. The Graph source has only unit tests. The NAS steps have not yet been run on a NAS.

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
