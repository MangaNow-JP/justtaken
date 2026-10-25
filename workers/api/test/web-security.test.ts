import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { handleRequest } from '../src/app';
import { SECURITY_TXT_EXPIRES } from '../src/security-headers';
import type { Bindings } from '../src/types';

const origin = 'https://justtaken.app';

test('Worker JSON responses carry the security baseline', async () => {
  const response = await handleRequest(new Request(origin + '/v1/me'));
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get('strict-transport-security'),
    'max-age=63072000; includeSubDomains',
  );
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(
    response.headers.get('content-security-policy')!,
    /^default-src 'none'; frame-ancestors 'none'/,
  );
});

test('HSTS is only sent over HTTPS', async () => {
  const response = await handleRequest(new Request('http://localhost/health'));
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('a denied preflight still carries the baseline', async () => {
  const response = await handleRequest(
    new Request(origin + '/v1/proofs', {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.invalid' },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('verify page allows only its own hashed inline style and enforces Trusted Types', async () => {
  const response = await handleRequest(new Request(origin + '/verify'));
  assert.equal(response.status, 200);
  const policy = response.headers.get('content-security-policy')!;
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.match(policy, /require-trusted-types-for 'script'; trusted-types justtaken-verify/);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  const html = await response.text();
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.equal(styles.length, 1);
  const digest = createHash('sha256').update(styles[0]).digest('base64');
  assert.ok(policy.includes(`style-src 'sha256-${digest}'`));
  assert.doesNotMatch(html, /\sstyle=|<script>|\son[a-z]+=/i);
});

test('security.txt follows RFC 9116', async () => {
  const response = await handleRequest(new Request(origin + '/.well-known/security.txt'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/plain; charset=utf-8/);
  const body = await response.text();
  assert.match(body, /^Contact: mailto:info@imakai\.co\.jp$/m);
  assert.match(body, /^Canonical: https:\/\/justtaken\.app\/\.well-known\/security\.txt$/m);
  assert.match(body, new RegExp(`^Expires: ${SECURITY_TXT_EXPIRES.replace(/\./g, '\\.')}$`, 'm'));
  assert.ok(!Number.isNaN(Date.parse(SECURITY_TXT_EXPIRES)));
  const head = await handleRequest(
    new Request(origin + '/.well-known/security.txt', { method: 'HEAD' }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

function registrationEnv() {
  const stored: unknown[][] = [];
  const env = {
    API_ORIGIN: origin,
    HOME: {
      prepare: () => ({ bind: (...values: unknown[]) => (stored.push(values), {}) }),
      batch: async () => [],
    },
  } as unknown as Bindings;
  return { env, stored };
}
async function register(env: Bindings, email: unknown) {
  return handleRequest(
    new Request(origin + '/public/early-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email, platform: 'ios', consent: true, website: '' }),
    }),
    env,
  );
}

test('early access accepts ordinary addresses and normalizes them', async () => {
  for (const [email, saved] of [
    ['  Early@Example.Invalid ', 'early@example.invalid'],
    ["o'brien+news@mail.example.co.jp", "o'brien+news@mail.example.co.jp"],
  ]) {
    const { env, stored } = registrationEnv();
    const response = await register(env, email);
    assert.equal(response.status, 202, email);
    assert.equal(stored.at(-1)![1], saved);
  }
});

test('early access rejects addresses a mailer could misread', async () => {
  for (const email of [
    'a@b',
    'a,b@example.com',
    'a;b@example.com',
    '"quoted"@example.com',
    'a b@example.com',
    'a@exa_mple.com',
    'a@-example.com',
    'a@example.com\r\nBcc: x@example.com',
    'a@example.com>',
    'あ@example.com',
    'x'.repeat(65) + '@example.com',
    42,
  ]) {
    const { env, stored } = registrationEnv();
    const response = await register(env, email);
    assert.equal(response.status, 400, String(email));
    assert.equal((await response.json()).error.code, 'INVALID_EMAIL');
    assert.equal(stored.length, 0);
  }
});
