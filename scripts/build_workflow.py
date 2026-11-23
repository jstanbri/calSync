#!/usr/bin/env python3
"""Build workflows/calsync.n8n.json from src/*.js and config/sources.json (falls back to the example)."""
import json, pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
cfg_path = root / "config" / "sources.json"
real = cfg_path.exists()
if not real:
    cfg_path = root / "config" / "sources.example.json"
    print(f"note: config/sources.json not found, using {cfg_path.name}", file=sys.stderr)
cfg = json.loads(cfg_path.read_text())
code = lambda n: (root / "src" / n).read_text()

GCAL = "https://www.googleapis.com/calendar/v3/calendars/"
cal_url = "={{ '" + GCAL + "' + encodeURIComponent($('Load Config').first().json.settings.masterCalendarId) + '/events' }}"
cred = {"googleCalendarOAuth2Api": {"id": "", "name": "Google Calendar account"}}
gauth = {"authentication": "predefinedCredentialType", "nodeCredentialType": "googleCalendarOAuth2Api"}

def node(name, type_, ver, pos, params, **kw):
    n = {"parameters": params, "id": name.lower().replace(" ", "-").replace("&", "and"), "name": name,
         "type": type_, "typeVersion": ver, "position": pos}
    n.update(kw)
    return n

def write(name, method, pos, url_expr):
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": method, "url": url_expr, **gauth,
        **({} if method == "DELETE" else {"sendBody": True, "specifyBody": "json",
                                           "jsonBody": "={{ JSON.stringify($json.body) }}"}),
    }, credentials=cred, retryOnFail=True)

item_url = "={{ '" + GCAL + "' + encodeURIComponent($json.calendarId) + '/events/' + $json.id }}"
ins_url = "={{ '" + GCAL + "' + encodeURIComponent($json.calendarId) + '/events' }}"

nodes = [
    node("Daily 05:00", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 200],
         {"rule": {"interval": [{"field": "cronExpression", "expression": "0 5 * * *"}]}}),
    node("Load Config", "n8n-nodes-base.code", 2, [220, 200], {"jsCode": code("load_config.js").replace("__CONFIG__", json.dumps(cfg, indent=2))}),
    node("Fetch ICS", "n8n-nodes-base.httpRequest", 4.2, [440, 100], {
        "url": "={{ $json.source.url }}",
        "options": {"response": {"response": {"responseFormat": "text", "outputPropertyName": "data"}}, "timeout": 30000}},
        onError="continueRegularOutput", retryOnFail=True),
    node("Parse ICS", "n8n-nodes-base.code", 2, [660, 100], {"mode": "runOnceForEachItem", "jsCode": code("parse.js")}),
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
    node("Combine", "n8n-nodes-base.merge", 3, [880, 200], {}),
    node("Dedupe and Diff", "n8n-nodes-base.code", 2, [1100, 200], {"jsCode": code("dedupe.js")}),
    node("Route Action", "n8n-nodes-base.switch", 3.2, [1320, 200], {"rules": {"values": [
        {"conditions": {"options": {"caseSensitive": True, "typeValidation": "strict", "version": 2},
                        "combinator": "and", "conditions": [{"leftValue": "={{ $json.action }}", "rightValue": a,
                                                              "operator": {"type": "string", "operation": "equals"}}]},
         "renameOutput": True, "outputKey": a} for a in ("create", "update", "delete")]}, "options": {}}),
    write("Create Event", "POST", [1560, 80], ins_url),
    write("Update Event", "PUT", [1560, 220], item_url),
    write("Delete Event", "DELETE", [1560, 360], item_url),
]
conn = lambda *outs: {"main": [[{"node": t, "type": "main", "index": 0} for t in o] for o in outs]}
connections = {
    "Daily 05:00": conn(["Load Config"]),
    "Load Config": conn(["Fetch ICS", "Get Master Events"]),
    "Fetch ICS": conn(["Parse ICS"]),
    "Parse ICS": conn(["Combine"]),
    "Get Master Events": {"main": [[{"node": "Combine", "type": "main", "index": 1}]]},
    "Combine": conn(["Dedupe and Diff"]),
    "Dedupe and Diff": conn(["Route Action"]),
    "Route Action": conn(["Create Event"], ["Update Event"], ["Delete Event"]),
}
wf = {"name": "calSync", "nodes": nodes, "connections": connections,
      "settings": {"executionOrder": "v1"}, "active": False}
# Real config contains secret ICS URLs: write to gitignored build/, never to the tracked template.
out = root / ("build" if real else "workflows") / "calsync.n8n.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(wf, indent=2) + "\n")
print("wrote", out.relative_to(root))
