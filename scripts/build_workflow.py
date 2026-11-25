#!/usr/bin/env python3
"""Build workflows/calsync.n8n.json from src/*.js and config/sources.json (falls back to the example)."""
import json, pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
cfg_path = root / "config" / "sources.json"
real = cfg_path.exists() and "--template" not in sys.argv  # --template: rebuild the tracked placeholder workflow
if not real:
    cfg_path = root / "config" / "sources.example.json"
    print(f"note: using {cfg_path.name}", file=sys.stderr)
cfg = json.loads(cfg_path.read_text())
code = lambda n: (root / "src" / n).read_text()

GCAL = "https://www.googleapis.com/calendar/v3/calendars/"
cal_url = "={{ '" + GCAL + "' + encodeURIComponent($('Load Config').first().json.settings.masterCalendarId) + '/events' }}"
import os
# Optional: CALSYNC_GCAL_CRED_ID=<n8n credential id> pre-links the Google credential on the HTTP nodes.
cred = {"googleCalendarOAuth2Api": {"id": os.environ.get("CALSYNC_GCAL_CRED_ID", ""), "name": "Google Calendar account"}}
mscred = {"microsoftOutlookOAuth2Api": {"id": os.environ.get("CALSYNC_MS_CRED_ID", ""), "name": "Microsoft Outlook account"}}
gauth = {"authentication": "predefinedCredentialType", "nodeCredentialType": "googleCalendarOAuth2Api"}

def _creds(kw):
    # drop credential blocks with no id: n8n refuses to run a workflow containing an unresolved credential
    c = kw.get("credentials")
    if c and not any(v.get("id") for v in c.values()):
        kw = {k: v for k, v in kw.items() if k != "credentials"}
    return kw

def node(name, type_, ver, pos, params, **kw):
    kw = _creds(kw)
    n = {"parameters": params, "id": name.lower().replace(" ", "-").replace("&", "and"), "name": name,
         "type": type_, "typeVersion": ver, "position": pos}
    n.update(kw)
    return n

PACE = {"options": {"batching": {"batch": {"batchSize": 1, "batchInterval": 500}}}}
# Update reads its inputs from "Dedupe and Diff" so it works both from the Switch and from Create's 409 error branch.
SRC = "$('Dedupe and Diff').item.json"

def write(name, method, pos, url_expr, body_expr="={{ JSON.stringify($json.body) }}", **kw):
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": method, "url": url_expr, **gauth, **PACE,
        **({} if method == "DELETE" else {"sendBody": True, "specifyBody": "json", "jsonBody": body_expr}),
    }, credentials=cred, **kw)

item_url = "={{ '" + GCAL + "' + encodeURIComponent($json.calendarId) + '/events/' + $json.id }}"
ins_url = "={{ '" + GCAL + "' + encodeURIComponent($json.calendarId) + '/events' }}"

nodes = [
    node("Daily 05:00", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 200],
         {"rule": {"interval": [{"field": "cronExpression", "expression": "0 5 * * *"}]}}),
    node("Manual Run", "n8n-nodes-base.manualTrigger", 1, [0, 360], {}),
    node("Load Config", "n8n-nodes-base.code", 2, [220, 200], {"jsCode": code("load_config.js").replace("__CONFIG__", json.dumps(cfg, indent=2))}),
    node("By Type", "n8n-nodes-base.switch", 3.2, [440, 200], {"rules": {"values": [
        {"conditions": {"options": {"caseSensitive": True, "typeValidation": "strict", "version": 2},
                        "combinator": "and", "conditions": [{"leftValue": "={{ $json.source.type }}", "rightValue": t,
                                                              "operator": {"type": "string", "operation": "equals"}}]},
         "renameOutput": True, "outputKey": t} for t in ("ics", "graph")]}, "options": {}}),
    node("Fetch Graph", "n8n-nodes-base.httpRequest", 4.2, [660, 240], {
        "url": "https://graph.microsoft.com/v1.0/me/calendarView",
        "authentication": "predefinedCredentialType", "nodeCredentialType": "microsoftOutlookOAuth2Api",
        "sendQuery": True, "queryParameters": {"parameters": [
            {"name": "startDateTime", "value": "={{ new Date(Date.now() - $json.settings.daysBack * 864e5).toISOString() }}"},
            {"name": "endDateTime", "value": "={{ new Date(Date.now() + $json.settings.daysForward * 864e5).toISOString() }}"},
            {"name": "$top", "value": "100"},
            {"name": "$select", "value": "subject,start,end,isAllDay,isCancelled,location,bodyPreview"}]},
        "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Prefer", "value": "outlook.timezone=\"UTC\""}]},
        "options": {"pagination": {"pagination": {
            "paginationMode": "responseContainsNextURL", "nextURL": "={{ $response.body['@odata.nextLink'] }}",
            "paginationCompleteWhen": "other", "completeExpression": "={{ !$response.body['@odata.nextLink'] }}",
            "limitPagesFetched": True, "maxRequests": 20}}, "timeout": 30000}},
        credentials=mscred, onError="continueRegularOutput", retryOnFail=True),
    node("Parse Graph", "n8n-nodes-base.code", 2, [880, 240], {"mode": "runOnceForEachItem", "jsCode": code("parse_graph.js")}),
    node("Fetch ICS", "n8n-nodes-base.httpRequest", 4.2, [660, 100], {
        "url": "={{ $json.source.url }}",
        "options": {"response": {"response": {"responseFormat": "text", "outputPropertyName": "data"}}, "timeout": 30000}},
        onError="continueRegularOutput", retryOnFail=True),
    node("Parse ICS", "n8n-nodes-base.code", 2, [880, 100], {"mode": "runOnceForEachItem", "jsCode": code("parse.js")}),
    node("Get Master Events", "n8n-nodes-base.httpRequest", 4.2, [440, 300], {
        "url": cal_url, **gauth, "sendQuery": True,
        "queryParameters": {"parameters": [
            {"name": "privateExtendedProperty", "value": "calSync=1"},
            {"name": "timeMin", "value": "={{ new Date(Date.now() - $json.settings.daysBack * 864e5).toISOString() }}"},
            {"name": "timeMax", "value": "={{ new Date(Date.now() + $json.settings.daysForward * 864e5).toISOString() }}"},
            {"name": "singleEvents", "value": "true"},
            {"name": "showDeleted", "value": "false"},
            {"name": "maxResults", "value": "2500"}]}},
        credentials=cred, executeOnce=True),
    node("Combine", "n8n-nodes-base.merge", 3.2, [1100, 200], {"numberInputs": 3}),
    node("Dedupe and Diff", "n8n-nodes-base.code", 2, [1320, 200], {"jsCode": code("dedupe.js")}),
    node("Route Action", "n8n-nodes-base.switch", 3.2, [1540, 200], {"rules": {"values": [
        {"conditions": {"options": {"caseSensitive": True, "typeValidation": "strict", "version": 2},
                        "combinator": "and", "conditions": [{"leftValue": "={{ $json.action }}", "rightValue": a,
                                                              "operator": {"type": "string", "operation": "equals"}}]},
         "renameOutput": True, "outputKey": a} for a in ("create", "update", "delete")]}, "options": {}}),
    # No node-level retryOnFail on writes: it re-sends the whole batch. Failed items go to the error output,
    # are classified by "<Op> Error", and only those are retried.
    write("Create Event", "POST", [1780, 80], ins_url, onError="continueErrorOutput"),
    write("Update Event", "PUT", [1780, 260], "={{ 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(" + SRC + ".calendarId) + '/events/' + " + SRC + ".id }}",
          "={{ JSON.stringify(" + SRC + ".body) }}", onError="continueErrorOutput"),
    write("Delete Event", "DELETE", [1780, 440], item_url, onError="continueErrorOutput"),
]
conn = lambda *outs: {"main": [[{"node": t, "type": "main", "index": 0} for t in o] for o in outs]}
connections = {
    "Daily 05:00": conn(["Load Config"]),
    "Manual Run": conn(["Load Config"]),
    "Load Config": conn(["By Type", "Get Master Events"]),
    "By Type": conn(["Fetch ICS"], ["Fetch Graph"]),
    "Fetch ICS": conn(["Parse ICS"]),
    "Fetch Graph": conn(["Parse Graph"]),
    "Parse ICS": {"main": [[{"node": "Combine", "type": "main", "index": 0}]]},
    "Parse Graph": {"main": [[{"node": "Combine", "type": "main", "index": 1}]]},
    "Get Master Events": {"main": [[{"node": "Combine", "type": "main", "index": 2}]]},
    "Combine": conn(["Dedupe and Diff"]),
    "Dedupe and Diff": conn(["Route Action"]),
    "Route Action": conn(["Create Event"], ["Update Event"], ["Delete Event"]),
}
# Error handling per write: exists -> Update, retry -> wait with backoff and re-send, gone -> done, else fail the run.
def route_is(value):
    return {"conditions": {"options": {"caseSensitive": True, "typeValidation": "strict", "version": 2},
                           "combinator": "and", "conditions": [{"leftValue": "={{ $json.route }}", "rightValue": value,
                                                                "operator": {"type": "string", "operation": "equals"}}]},
            "renameOutput": True, "outputKey": value}

for op, y in (("create", 80), ("update", 260), ("delete", 440)):
    Op = op.title()
    routes = ["retry", "fatal"] + {"create": ["exists"], "update": [], "delete": ["gone"]}[op]
    wait = node(f"{Op} Backoff", "n8n-nodes-base.wait", 1.1, [2440, y],
                {"amount": "={{ Math.min(60, 5 * 2 ** $json.attempts." + op + ") }}", "unit": "seconds"},
                webhookId=f"calsync-{op}-backoff")
    nodes += [
        node(f"{Op} Error", "n8n-nodes-base.code", 2, [2000, y],
             {"mode": "runOnceForEachItem", "jsCode": code("write_error.js").replace("__OP__", op)}),
        node(f"{Op} Error Route", "n8n-nodes-base.switch", 3.2, [2220, y],
             {"rules": {"values": [route_is(r) for r in routes]}, "options": {}}),
        wait,
        node(f"{Op} Failed", "n8n-nodes-base.stopAndError", 1, [2440, y + 100],
             {"errorMessage": "={{ 'calSync " + op + " failed: ' + ($json.error.description || $json.error.message) }}"}),
    ]
    connections[f"{Op} Event"] = conn([], [f"{Op} Error"])
    connections[f"{Op} Error"] = conn([f"{Op} Error Route"])
    targets = {"retry": [f"{Op} Backoff"], "fatal": [f"{Op} Failed"], "exists": ["Update Event"], "gone": []}
    connections[f"{Op} Error Route"] = conn(*[targets[r] for r in routes])
    connections[f"{Op} Backoff"] = conn([f"{Op} Event"])

wf = {"id": "calSyncWorkflow01", "name": "calSync", "nodes": nodes, "connections": connections,
      "settings": {"executionOrder": "v1", "timezone": "Europe/London"}, "active": False}
# Real config contains secret ICS URLs: write to gitignored build/, never to the tracked template.
out = root / ("build" if real else "workflows") / "calsync.n8n.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(wf, indent=2) + "\n")
print("wrote", out.relative_to(root))
