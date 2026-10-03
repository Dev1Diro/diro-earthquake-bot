import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSecrets, redact, embedText } from '../security.js';

test('configured secrets and URL-encoded keys are redacted repeatedly without exposing values', () => {
  configureSecrets(['secret+key/value=', 'secret-discord-token']);
  const raw = 'secret-discord-token https://example.test/?serviceKey=secret%2Bkey%2Fvalue%3D token=another-secret';
  const safe = redact(raw);
  assert.doesNotMatch(safe, /secret-discord-token|secret%2B|secret\+key|another-secret/);
  assert.equal(redact(safe), safe);
  configureSecrets([]);
});

test('embeds suppress mention and markdown injection while enforcing field limits', () => {
  const safe = embedText('@everyone <@123456789012345678> **spoofed** `code`', 1024);
  assert.doesNotMatch(safe, /@everyone|<@\d/);
  assert.match(safe, /\\\*\\\*/);
  assert.equal(embedText('a'.repeat(1500), 1024).length, 1024);
});
