const assert = require('assert');
const fs = require('fs');
// The file ends in an n8n-style top-level return, so evaluate it as a function body.
const mod = { exports: {} };
new Function('module', fs.readFileSync(__dirname + '/../src/write_error.js', 'utf8'))(mod);
const { classify, MAX_RETRIES } = mod.exports;
const err = (status, reason) => ({ message: 'x', cause: { message: `${status} - "{\\"reason\\": \\"${reason}\\"}"` } });

assert.strictEqual(classify('create', err(409, 'duplicate'), 0), 'exists');
assert.strictEqual(classify('create', err(403, 'rateLimitExceeded'), 0), 'retry');
assert.strictEqual(classify('create', { message: 'Forbidden - perhaps check your credentials?', description: 'Rate Limit Exceeded' }, 0), 'retry');
assert.strictEqual(classify('update', err(429, 'x'), 0), 'retry');
assert.strictEqual(classify('update', err(503, 'backendError'), 0), 'retry');
assert.strictEqual(classify('create', err(403, 'rateLimitExceeded'), MAX_RETRIES), 'fatal');
assert.strictEqual(classify('create', err(403, 'forbidden'), 0), 'fatal');
assert.strictEqual(classify('create', err(401, 'authError'), 0), 'fatal');
assert.strictEqual(classify('update', err(404, 'notFound'), 0), 'fatal');
assert.strictEqual(classify('delete', err(410, 'deleted'), 0), 'gone');
assert.strictEqual(classify('delete', err(404, 'notFound'), 0), 'gone');
// Real shape of a 429 from n8n 2.48.8: no status in the message, only in the stack.
assert.strictEqual(classify('delete', { message: "Try spacing your requests out using the batching settings under 'Options'",
  name: 'AxiosError', stack: 'AxiosError: Request failed with status code 429\n    at settle' }, 0), 'retry');
console.log('write_error tests passed');
