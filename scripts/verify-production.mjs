import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Public smoke checks only: no login, uploads, real proofs or test accounts.
const origin = process.argv[2] || 'https://justtaken.app';
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).protocol, 'https:');
const canonicalOrigin = 'https://justtaken.app';
const pinnedKeys = JSON.parse(
  await readFile(
    new URL('../workers/api/trust/justtaken-production-jwks.json', import.meta.url),
    'utf8',
  ),
);
const results = [];
let health;
const HSTS = 'max-age=63072000; includeSubDomains';
// Baseline from public/_headers (static) and src/security-headers.ts (Worker responses).
function assertBaseline(response) {
  assert.equal(response.headers.get('strict-transport-security'), HSTS);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}
async function request(path, options = {}) {
  return fetch(origin + path, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
}
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.cause?.code || error.message });
  }
}

await check('HTTPS health', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assertBaseline(response);
  assert.match(response.headers.get('content-security-policy'), /^default-src 'none'/);
  health = await response.json();
  assert.equal(health.service, 'JustTaken');
  assert.equal(health.status, 'ok');
  assert.equal(health.capabilities.externalAnchoring, true);
});
await Promise.all([
  ...['/', '/privacy', '/terms', '/legal/archive/privacy-2026-10-25', '/credits'].map((path) =>
    check('Landing page: ' + path, async () => {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const policy = response.headers.get('content-security-policy');
      assert.match(policy, /frame-ancestors 'none'/);
      assert.match(policy, /require-trusted-types-for 'script'/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
      assertBaseline(response);
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
      const body = await response.text();
      assert.match(body, /JustTaken/);
      assert.match(body, /株式会社IMAKAI/);
      assert.match(body, /rel="canonical"/);
      if (path.startsWith('/legal/archive/')) assert.match(body, /noindex,follow/);
      if (path === '/terms' || path === '/privacy') {
        assert.match(body, /class="legal-toc"/);
        assert.match(body, /info@imakai\.co\.jp/);
        assert.match(body, /href="\/terms"/);
        assert.match(body, /href="\/privacy"/);
      }
      if (path === '/') {
        assert.match(body, /盛らない、つくらない。/);
        assert.match(body, /id="signup-form"/);
        assert.match(body, /id="watermark-toggle"/);
      }
    }),
  ),
  ...[
    ['/assets/site.css?v=8', 'public, max-age=31536000, immutable'],
    ['/assets/site.js?v=4', 'public, max-age=31536000, immutable'],
    ['/assets/legal.css?v=2', 'public, max-age=31536000, immutable'],
    ['/assets/landing-jp.woff2?v=8', 'public, max-age=31536000, immutable'],
    ['/assets/friends-960.webp', 'public, max-age=604800'],
    ['/assets/og-cover.png', 'public, max-age=604800'],
    ['/assets/favicon.svg', 'public, max-age=604800'],
    ['/robots.txt', 'public, max-age=0, must-revalidate'],
    ['/sitemap.xml', 'public, max-age=0, must-revalidate'],
  ].map(([path, cacheControl]) =>
    check('Landing asset: ' + path, async () => {
      const response = await request(path);
      assert.equal(response.status, 200);
      // _headers joins repeated names; a single value proves the page policy was detached.
      assert.equal(response.headers.get('cache-control'), cacheControl);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((await response.arrayBuffer()).byteLength > 50);
    }),
  ),
  check('security.txt is current', async () => {
    const response = await request('/.well-known/security.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    const body = await response.text();
    assert.match(body, /^Contact: /m);
    const expires = Date.parse(/^Expires: (.+)$/m.exec(body)?.[1]);
    // Renew SECURITY_TXT_EXPIRES in workers/api/src/security-headers.ts before this fails.
    assert.ok(expires - Date.now() > 30 * 86400000, 'security.txt expires within 30 days');
  }),
  check('Registration has no public email-list endpoint', async () => {
    const response = await request('/public/early-access');
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }),
  check('Production signing public key matches independently saved key', async () => {
    const response = await request('/.well-known/capture-jwks.json');
    assert.equal(response.status, 200);
    const jwks = await response.json();
    assert.deepEqual(jwks, pinnedKeys);
    for (const key of jwks.keys) {
      assert.equal(key.d, undefined);
      assert.equal(key.kty, 'EC');
      assert.equal(key.crv, 'P-256');
      assert.equal(key.alg, 'ES256');
    }
  }),
  check('Capture policy', async () => {
    const response = await request('/v1/policy');
    assert.equal(response.status, 200);
    const policy = await response.json();
    assert.equal(policy.accountDefault, 'private');
    assert.equal(policy.videoEnabled, true);
    if (health) assert.equal(policy.captureEnabled, health.capabilities.captureVerification);
  }),
  ...['/verify', '/verify.js', '/verify-hash.js'].map((path) =>
    check(path, async () => {
      const response = await request(path);
      assert.equal(response.status, 200);
      const policy = response.headers.get('content-security-policy');
      assert.match(policy, /frame-ancestors 'none'/);
      assert.match(policy, /trusted-types justtaken-verify/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
      assertBaseline(response);
      const body = await response.text();
      assert.ok(body.length > 1000);
      if (path === '/verify') assert.match(body, /撮影証明/);
    }),
  ),
  ...[
    '/v1/me',
    '/v1/posts',
    '/v1/users?q=justtaken',
    '/v1/follow-requests',
    '/v1/saved-posts',
    '/v1/notifications',
    '/v1/proofs',
    '/v1/proofs/00000000-0000-4000-8000-000000000000/location',
    '/v1/captures/not-a-real-capture',
  ].map((path) =>
    check('Unauthenticated denied: ' + path, async () => {
      const response = await request(path);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
    }),
  ),
  check('Test-only seed route is absent', async () => {
    const response = await request('/__fixture/seed', { method: 'POST' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }),
  check('D1-backed nonexistent share returns 404', async () => {
    const response = await request('/public/proof-shares/00000000-0000-4000-8000-000000000000', {
      method: 'POST',
      headers: { 'X-Proof-Token': 'A'.repeat(43) },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'SHARE_UNAVAILABLE');
  }),
  check('Untrusted CORS preflight denied', async () => {
    const response = await request('/v1/proofs', {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.invalid', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }),
  check('Canonical origin CORS preflight allowed', async () => {
    const response = await request('/v1/proofs', {
      method: 'OPTIONS',
      headers: { Origin: canonicalOrigin, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), canonicalOrigin);
  }),
  ...(health
    ? Object.entries(health.providers)
        .filter(([, enabled]) => !enabled)
        .map(([provider]) =>
          check('Unconfigured provider fails closed: ' + provider, async () => {
            const response = await request('/v1/auth/challenge', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider, codeChallenge: 'A'.repeat(43) }),
            });
            assert.equal(response.status, 503);
            assert.equal((await response.json()).error.code, 'CONFIGURATION_REQUIRED');
          }),
        )
    : []),
]);

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      origin,
      health,
      checks: results.sort((a, b) => a.name.localeCompare(b.name)),
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.ok)) process.exitCode = 1;
