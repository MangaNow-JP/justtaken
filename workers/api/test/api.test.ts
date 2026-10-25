import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRequest } from '../src/app';
test('health discloses unavailable capabilities without claiming attestation', async () => {
  const response = await handleRequest(new Request('http://localhost/health'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capabilities.captureVerification, false);
  assert.equal(body.capabilities.publication, false);
});
test('policy keeps accounts private and capture publication off', async () => {
  const response = await handleRequest(new Request('http://localhost/v1/policy'));
  const body = await response.json();
  assert.equal(body.accountDefault, 'private');
  assert.equal(body.captureEnabled, false);
  assert.equal(body.capture.commitWindowMs, 300000);
});
for (const path of [
  '/v1/capture-sessions',
  '/v1/capture-sessions/cs_1/commit',
  '/v1/assets/asset1/content',
  '/v1/posts',
  '/v1/media-grants',
])
  test(`no development bypass for ${path}`, async () => {
    const anonymous = await handleRequest(
      new Request('http://localhost' + path, { method: 'POST' }),
    );
    assert.equal(anonymous.status, 401);
    const forged = await handleRequest(
      new Request('http://localhost' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer demo-token' },
      }),
    );
    assert.equal(forged.status, 401);
    assert.equal(forged.headers.get('Cache-Control'), 'no-store');
  });
