import test from 'node:test';
import assert from 'node:assert/strict';
import { startupConflicts } from '../src/startup-diagnostics.js';

test('startup diagnostics reconstruct only fixed tool-conflict messages and redact secrets', () => {
  const raw = [
    'Authorization: Bearer PRIVATE_TOKEN',
    'Error: Failed to load extension "/plugins/search.js": Tool "web_search" conflicts with /picall/runtime.mjs',
    'Error: Tool "PRIVATE_TOKEN" conflicts with https://example.com?api_key=PRIVATE_TOKEN',
    'Error: Tool "fetch_content" conflicts with another extension PASSWORD_DUMP',
    'Failed to load extension: arbitrary provider content PRIVATE_TOKEN',
  ].join('\n');
  const result = startupConflicts(raw, ['PRIVATE_TOKEN']);
  assert.equal(result.length, 3);
  assert.equal(result[0].source, '/plugins/search.js');
  assert.equal(result[0].tool, 'web_search');
  assert.equal(result[1].tool, '[redacted]');
  const exposed = JSON.stringify(result.map(item => item.message));
  for (const value of ['PRIVATE_TOKEN', 'PASSWORD_DUMP', 'api_key', '/plugins', '/picall', 'https:']) assert.ok(!exposed.includes(value));
  assert.ok(exposed.includes('web_search'));
  assert.equal(startupConflicts('API key invalid\nstack trace\nsecret').length, 0);
});
