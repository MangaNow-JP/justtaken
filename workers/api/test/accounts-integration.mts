// Runs only against an isolated workerd/D1/R2 instance. No production credentials or data.
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT, jwtVerify, importJWK } from 'jose';
const identityKey = await generateKeyPair('RS256', { extractable: true });
const clientKey = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(identityKey.publicKey)), kid: 'apple-fixture', alg: 'RS256' };
const issued = new Map<string, string>();
let revoked = 0,
  outage = true;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'accounts-test',
        modules: true,
        scriptPath: 'artifacts/test-worker/fixture-worker.js',
        compatibilityDate: '2026-10-25',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          AUTH: { className: 'FixtureAuth', useSQLite: true },
          CAPTURE: { className: 'FixtureCapture', useSQLite: true },
        },
        d1Databases: ['HOME'],
        r2Buckets: ['STAGING', 'ORIGINALS'],
        bindings: {
          ENVIRONMENT: 'development',
          MODERATOR_USER_IDS: 'moderator',
          PROVIDER_TOKEN_KEY: randomBytes(32).toString('base64url'),
          APPLE_AUDIENCE: 'app.justtaken.test',
          APPLE_TEAM_ID: 'TEAMTEST00',
          APPLE_KEY_ID: 'test-key',
          APPLE_PRIVATE_KEY: await exportPKCS8(clientKey.privateKey),
          GOOGLE_CLIENT_ID: 'google-fixture',
          GOOGLE_CLIENT_SECRET: 'fixture-only',
          APP_RETURN_URL: 'justtaken://auth',
          API_ORIGIN: 'http://test',
          MEDIA_SECRET: randomBytes(32).toString('hex'),
        },
        outboundService: async (request) => {
          if (
            request.url === 'https://appleid.apple.com/auth/keys' ||
            request.url === 'https://www.googleapis.com/oauth2/v3/certs'
          )
            return Response.json({ keys: [jwk] });
          if (request.url === 'https://appleid.apple.com/auth/token') {
            const data = new URLSearchParams(await request.text());
            const secret = await jwtVerify(data.get('client_secret')!, clientKey.publicKey, {
              issuer: 'TEAMTEST00',
              audience: 'https://appleid.apple.com',
            });
            assert.equal(secret.payload.sub, 'app.justtaken.test');
            const id = issued.get(data.get('code')!);
            issued.delete(data.get('code')!);
            return id
              ? Response.json({ id_token: id, refresh_token: 'fixture-provider-token' })
              : Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          if (request.url === 'https://appleid.apple.com/auth/revoke') {
            const data = new URLSearchParams(await request.text());
            assert.equal(data.get('token'), 'fixture-provider-token');
            if (outage) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            revoked++;
            return new Response(null, { status: 200 });
          }
          if (request.url === 'https://oauth2.googleapis.com/token') {
            const data = new URLSearchParams(await request.text());
            const id = issued.get(data.get('code')!);
            issued.delete(data.get('code')!);
            return id
              ? Response.json({ id_token: id, refresh_token: 'fixture-google-refresh' })
              : Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          if (request.url === 'https://oauth2.googleapis.com/revoke') {
            const data = new URLSearchParams(await request.text());
            assert.equal(data.get('token'), 'fixture-google-refresh');
            return new Response(null, { status: 200 });
          }
          throw new Error('Unexpected external request: ' + new URL(request.url).origin);
        },
      },
    ],
  }),
);
let checks = 0;
function eq(actual: unknown, expected: unknown, message: string) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
async function call(path: string, method = 'GET', body?: unknown, access?: string) {
  const res = await mf.dispatchFetch('http://test' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(access ? { Authorization: 'Bearer ' + access } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
try {
  const db = await mf.getD1Database('HOME');
  for (const name of (await readdir('workers/api/migrations/home'))
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    let current = '',
      trigger = false;
    for (const line of (await readFile('workers/api/migrations/home/' + name, 'utf8')).split(
      '\n',
    )) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      current += line + ' ';
      if (/^CREATE TRIGGER/.test(current.trim())) trigger = true;
      if ((!trigger && line.trim().endsWith(';')) || (trigger && line.trim() === 'END;')) {
        await db.prepare(current).run();
        current = '';
        trigger = false;
      }
    }
  }
  async function seed(userId: string) {
    const s = {
      userId,
      sessionId: randomUUID(),
      installationId: randomUUID(),
      access: randomBytes(32).toString('base64url'),
      refresh: randomBytes(32).toString('base64url'),
      publicKey: 'fixture',
    };
    eq((await call('/__fixture/seed', 'POST', s)).status, 200, 'test fixture created');
    return { ...s, access: s.sessionId + '.' + s.access, refresh: s.sessionId + '.' + s.refresh };
  }
  const owner = await seed('owner'),
    viewer = await seed('viewer'),
    stranger = await seed('stranger'),
    moderator = await seed('moderator');
  const post = randomUUID(),
    capture = randomUUID();
  await db.prepare("UPDATE profiles SET is_private=0 WHERE user_id='owner'").run();
  await db
    .prepare(
      `INSERT INTO posts(post_id,author_id,bucket_id,capture_id,installation_id,caption,visibility,state,moderation,created_at)
    VALUES(?,'owner',0,?,?,'review content','public','PUBLISHED','ALLOWED',?)`,
    )
    .bind(post, capture, owner.installationId, new Date().toISOString())
    .run();
  await call('/__fixture/patch-capture', 'POST', {
    installationId: owner.installationId,
    captureId: capture,
    patch: {
      id: capture,
      userId: 'owner',
      installationId: owner.installationId,
      state: 'VERIFIED',
      verifiedAt: new Date().toISOString(),
      manifest: { assets: [{ id: 'original', mime: 'image/jpeg', sha256: 'a'.repeat(64) }] },
    },
  });
  const bucket = await mf.getR2Bucket('ORIGINALS');
  await bucket.put(
    `${owner.installationId}/${capture}/original/${'a'.repeat(64)}.jpg`,
    'private bytes',
  );
  eq(
    (await call('/v1/moderation/queue', 'GET', undefined, viewer.access)).status,
    403,
    'ordinary user cannot read moderation queue',
  );
  eq(
    (
      await call(
        `/v1/moderation/posts/${post}/decision`,
        'POST',
        { action: 'BLOCKED', note: 'test', revision: 1 },
        viewer.access,
      )
    ).status,
    403,
    'ordinary user cannot moderate',
  );
  eq(
    (
      await call(
        `/v1/posts/${post}/reports`,
        'POST',
        { reason: 'invalid-reason', details: '' },
        viewer.access,
      )
    ).status,
    400,
    'unknown report reason rejected',
  );
  eq(
    (
      await call(
        `/v1/posts/${post}/reports`,
        'POST',
        { reason: 'illegal', details: 'test report' },
        viewer.access,
      )
    ).status,
    201,
    'visible post can be reported',
  );
  eq(
    (
      await call(
        `/v1/posts/${post}/reports`,
        'POST',
        { reason: 'illegal', details: 'retry' },
        viewer.access,
      )
    ).status,
    200,
    'report retry is idempotent',
  );
  const queue = await call('/v1/moderation/queue', 'GET', undefined, moderator.access);
  eq(queue.body.posts[0].reports.length, 1, 'report is in operator queue');
  eq('reporter_id' in queue.body.posts[0].reports[0], false, 'queue omits reporter identity');
  eq((await call('/v1/blocks/owner', 'POST', {}, viewer.access)).status, 200, 'block accepted');
  eq(
    (
      await call(
        `/v1/posts/${post}/reports`,
        'POST',
        { reason: 'other', details: '' },
        viewer.access,
      )
    ).status,
    404,
    'blocked account content inaccessible',
  );
  eq(
    (await call('/v1/feed', 'GET', undefined, viewer.access)).body.posts.length,
    0,
    'blocked author removed from feed',
  );
  eq(
    (await call('/v1/blocks/owner', 'DELETE', undefined, stranger.access)).status,
    200,
    'other user delete is scoped to themselves',
  );
  eq(
    (await call('/v1/blocks', 'GET', undefined, viewer.access)).body.blocks.length,
    1,
    'other user cannot remove your block',
  );
  eq(
    (await call('/v1/blocks/owner', 'DELETE', undefined, viewer.access)).status,
    200,
    'owner can unblock',
  );
  eq(
    (
      await call(
        `/v1/moderation/posts/${post}/decision`,
        'POST',
        { action: 'BLOCKED', note: 'policy violation', revision: 1 },
        moderator.access,
      )
    ).status,
    200,
    'moderator hides reported content',
  );
  eq(
    (await call('/v1/feed', 'GET', undefined, viewer.access)).body.posts.length,
    0,
    'moderated content absent from feed',
  );
  eq(
    (
      await call(
        `/v1/moderation/posts/${post}/decision`,
        'POST',
        { action: 'ALLOWED', note: 'stale review', revision: 1 },
        moderator.access,
      )
    ).status,
    409,
    'stale decision cannot overwrite newer moderation',
  );
  eq(
    (await db.prepare('SELECT status FROM user_reports').first<any>())!.status,
    'actioned',
    'report resolution persisted',
  );
  // Legacy account reports remain actionable after production-source reconciliation.
  eq(
    (
      await call(
        '/v1/reports',
        'POST',
        { userId: 'stranger', reason: 'harassment', details: 'fixture account report' },
        viewer.access,
      )
    ).status,
    201,
    'legacy user report accepted',
  );
  const accounts = (await call('/v1/moderation/queue', 'GET', undefined, moderator.access)).body
    .accountReports;
  eq(accounts.length, 1, 'legacy user report appears in operator queue');
  eq(
    (
      await call(
        `/v1/moderation/reports/${accounts[0].report_id}/decision`,
        'POST',
        { action: 'SUSPEND', note: 'verified fixture abuse' },
        viewer.access,
      )
    ).status,
    403,
    'user cannot suspend another account',
  );
  eq(
    (
      await call(
        `/v1/moderation/reports/${accounts[0].report_id}/decision`,
        'POST',
        { action: 'SUSPEND', note: 'verified fixture abuse' },
        moderator.access,
      )
    ).status,
    200,
    'moderator suspends reported account',
  );
  eq(
    (await call('/v1/me', 'GET', undefined, stranger.access)).status,
    401,
    'suspended account loses access immediately',
  );
  eq(
    (
      await call(
        `/v1/moderation/reports/${accounts[0].report_id}/decision`,
        'POST',
        { action: 'DISMISS', note: 'stale review' },
        moderator.access,
      )
    ).status,
    409,
    'resolved account report cannot be overwritten',
  );
  eq(
    (await call('/v1/auth/challenge', 'POST', { provider: 'apple' })).status,
    403,
    'age declaration cannot be omitted',
  );
  eq(
    (await call('/v1/auth/challenge', 'POST', { provider: 'apple', ageConfirmed18Plus: false }))
      .status,
    403,
    'false age declaration rejected',
  );
  const policy = (await call('/v1/policy')).body.community;
  await db.prepare('DELETE FROM user_consents WHERE user_id=?').bind('viewer').run();
  eq(
    (await call('/v1/me/consent', 'GET', undefined, viewer.access)).body.required,
    true,
    'missing consent is visible',
  );
  eq(
    (await call('/v1/posts', 'POST', {}, viewer.access)).status,
    403,
    'posting without consent blocked',
  );
  eq(
    (await call('/v1/blocks', 'GET', undefined, viewer.access)).status,
    200,
    'safety stays available without consent',
  );
  eq(
    (
      await call(
        '/v1/me/consent',
        'POST',
        { termsVersion: policy.termsVersion, privacyVersion: 'old', ageConfirmed18Plus: true },
        viewer.access,
      )
    ).status,
    400,
    'outdated privacy policy rejected',
  );
  eq(
    (
      await call(
        '/v1/me/consent',
        'POST',
        {
          termsVersion: policy.termsVersion,
          privacyVersion: policy.privacyVersion,
          ageConfirmed18Plus: true,
        },
        viewer.access,
      )
    ).status,
    200,
    'explicit current consent accepted',
  );
  const verifier = randomBytes(32).toString('base64url');
  const googleChallenge = (
    await call('/v1/auth/challenge', 'POST', {
      provider: 'google',
      ageConfirmed18Plus: true,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    })
  ).body;
  eq(
    new URL(googleChallenge.authorizationURL).searchParams.get('access_type'),
    'offline',
    'Google grant can be revoked after an access token expires',
  );
  issued.set(
    'google-code',
    await new SignJWT({ nonce: googleChallenge.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'apple-fixture' })
      .setSubject('google-user')
      .setIssuer('https://accounts.google.com')
      .setAudience('google-fixture')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(identityKey.privateKey),
  );
  const callback = await mf.dispatchFetch(
    'http://test/v1/auth/google/callback?state=' +
      googleChallenge.challengeId +
      '&code=google-code',
    { redirect: 'manual' },
  );
  eq(callback.status, 303, 'Google redirects to the app after verified exchange');
  const handoff = new URL(callback.headers.get('Location')!);
  const googleLogin = await call('/v1/auth/exchange', 'POST', {
    provider: 'google',
    challengeId: googleChallenge.challengeId,
    code: handoff.searchParams.get('code'),
    verifier,
  });
  eq(googleLogin.status, 200, 'Google handoff requires matching PKCE');
  eq(
    (
      await call(
        '/v1/me/deletion',
        'POST',
        { confirmation: 'DELETE' },
        googleLogin.body.accessToken,
      )
    ).status,
    202,
    'legacy deletion remains available',
  );
  await db.prepare('UPDATE account_deletions SET sweep_after=0,next_attempt=0').run();
  await call('/__fixture/deletions', 'POST', {});
  await db.prepare('UPDATE account_deletions SET sweep_after=0,next_attempt=0').run();
  await call('/__fixture/deletions', 'POST', {});
  eq(
    await db.prepare("SELECT * FROM provider_credentials WHERE provider='google'").first(),
    null,
    'Google refresh grant revoked and removed',
  );
  // Real JWT verification, code exchange, token encryption, refresh, then deletion and outage recovery.
  const challenge = (
    await call('/v1/auth/challenge', 'POST', { provider: 'apple', ageConfirmed18Plus: true })
  ).body;
  const identity = await new SignJWT({ nonce: challenge.nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-fixture' })
    .setSubject('apple-test-user')
    .setIssuer('https://appleid.apple.com')
    .setAudience('app.justtaken.test')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(identityKey.privateKey);
  issued.set('valid-code', identity);
  eq(
    (
      await call('/v1/auth/exchange', 'POST', {
        provider: 'apple',
        challengeId: challenge.challengeId,
        idToken: identity,
      })
    ).status,
    400,
    'Apple authorization code is mandatory',
  );
  const login = await call('/v1/auth/exchange', 'POST', {
    provider: 'apple',
    challengeId: challenge.challengeId,
    idToken: identity,
    authorizationCode: 'valid-code',
  });
  eq(login.status, 200, 'Apple identity and authorization code exchanged');
  const apple = login.body.profile.userId;
  eq(
    (await db
      .prepare('SELECT token_ciphertext FROM provider_credentials WHERE user_id=?')
      .bind(apple)
      .first<any>())!.token_ciphertext.includes('fixture-provider-token'),
    false,
    'provider token encrypted at rest',
  );
  eq(
    (
      await call('/v1/auth/exchange', 'POST', {
        provider: 'apple',
        challengeId: challenge.challengeId,
        idToken: identity,
        authorizationCode: 'valid-code',
      })
    ).status,
    401,
    'Apple challenge cannot be reused',
  );
  const rotated = await call('/v1/auth/refresh', 'POST', { refreshToken: login.body.refreshToken });
  eq(rotated.status, 200, 'refresh rotates login credentials');
  const receipt = randomBytes(32).toString('base64url');
  eq(
    (await call('/v1/me', 'DELETE', { confirmation: 'yes', receipt }, rotated.body.accessToken))
      .status,
    400,
    'deletion requires exact confirmation',
  );
  eq(
    (await call('/v1/me', 'DELETE', { confirmation: 'DELETE', receipt }, rotated.body.accessToken))
      .status,
    202,
    'deletion accepted durably',
  );
  eq(
    (await call('/v1/me', 'GET', undefined, rotated.body.accessToken)).status,
    401,
    'deleted account immediately loses session access',
  );
  eq(
    (await call('/v1/auth/refresh', 'POST', { refreshToken: rotated.body.refreshToken })).status,
    401,
    'deleted account cannot refresh',
  );
  eq(
    (await call('/v1/account/deletion-status', 'POST', { receipt })).body.status,
    'PENDING',
    'private receipt recovers ambiguous response',
  );
  eq(
    (
      await call('/v1/account/deletion-status', 'POST', {
        receipt: randomBytes(32).toString('base64url'),
      })
    ).status,
    404,
    'wrong receipt reveals nothing',
  );
  await db.prepare('UPDATE account_deletions SET sweep_after=0,next_attempt=0').run();
  await call('/__fixture/deletions', 'POST', {});
  eq(
    (await db.prepare('SELECT attempts FROM account_deletions').first<any>())!.attempts,
    1,
    'provider outage persists retry',
  );
  eq(
    (await db
      .prepare('SELECT COUNT(*) AS n FROM user_auth_sessions WHERE user_id=? AND purged=0')
      .bind(apple)
      .first<any>())!.n,
    0,
    'session registry removed despite provider outage',
  );
  outage = false;
  await db.prepare('UPDATE account_deletions SET next_attempt=0').run();
  await call('/__fixture/deletions', 'POST', {});
  await db.prepare('UPDATE account_deletions SET next_attempt=0,sweep_after=0').run();
  await call('/__fixture/deletions', 'POST', {});
  eq(revoked, 1, 'Apple grant revoked on retry');
  eq(
    (await call('/v1/account/deletion-status', 'POST', { receipt })).body.status,
    'COMPLETE',
    'deletion completes after retry',
  );
  eq(
    await db.prepare('SELECT * FROM profiles WHERE user_id=?').bind(apple).first(),
    null,
    'profile physically removed',
  );
  eq(
    await db.prepare('SELECT * FROM provider_credentials WHERE user_id=?').bind(apple).first(),
    null,
    'provider credentials physically removed',
  );
  eq(
    await db.prepare('SELECT * FROM account_deletions').first(),
    null,
    'completed job removed without user-linked audit trail',
  );
  const ownerReceipt = randomBytes(32).toString('base64url');
  await call('/v1/me', 'DELETE', { confirmation: 'DELETE', receipt: ownerReceipt }, owner.access);
  await db.prepare('UPDATE account_deletions SET sweep_after=0,next_attempt=0').run();
  await call('/__fixture/deletions', 'POST', {});
  await db.prepare('UPDATE account_deletions SET sweep_after=0,next_attempt=0').run();
  await call('/__fixture/deletions', 'POST', {});
  eq(
    (await bucket.list({ prefix: owner.installationId + '/' })).objects.length,
    0,
    'account media purged from R2',
  );
  eq(
    await db.prepare("SELECT * FROM posts WHERE author_id='owner'").first(),
    null,
    'posts removed',
  );
  eq(
    (
      await call(
        `/v1/installations/${owner.installationId}/captures/${capture}`,
        'GET',
        undefined,
        viewer.access,
      )
    ).status,
    410,
    'erased installation cannot be revived by another account',
  );
  console.log(`Account/auth/safety integration: ${checks} checks passed.`);
} finally {
  await mf.dispose();
}
