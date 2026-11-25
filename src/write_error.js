// n8n Code node — "<Op> Error", mode: Run Once for Each Item.
// Input: an HTTP write node's error output (the item it was sent, plus $json.error).
// Output: the item plus { route, attempts }. The build script replaces __OP__ with create|update|delete.
const MAX_RETRIES = 5;

// route: 'exists' (create only: switch to update) | 'gone' (delete only: nothing to do) | 'retry' | 'fatal'
function classify(op, error, retriesSoFar) {
  const text = JSON.stringify(error || {});
  // Where n8n puts the HTTP status varies: httpCode, a "403 - {...}" message, or (429) only the stack trace.
  const status = Number((text.match(/"httpCode":"?(\d{3})/) || text.match(/"(\d{3}) - /) ||
    text.match(/status code (\d{3})/) || [])[1]) || 0;
  if (op === 'create' && (status === 409 || /already exists/i.test(text))) return 'exists';
  if (op === 'delete' && (status === 404 || status === 410 || /has been deleted|could not be found/i.test(text))) return 'gone';
  const transient = status === 429 || status >= 500 ||
    /rateLimitExceeded|rate limit exceeded|too many requests|ECONNRESET|ETIMEDOUT|ECONNABORTED|EAI_AGAIN/i.test(text);
  return transient && retriesSoFar < MAX_RETRIES ? 'retry' : 'fatal';
}

if (typeof module !== 'undefined') module.exports = { classify, MAX_RETRIES };

if (typeof $json !== 'undefined') {
  const op = '__OP__';
  const attempts = { ...($json.attempts || {}) };
  const route = classify(op, $json.error, attempts[op] || 0);
  if (route === 'retry') attempts[op] = (attempts[op] || 0) + 1;
  return { json: { ...$json, route, attempts } };
}
