import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { generateKeyPair, exportJWK, compactVerify, importJWK } from 'jose';
import cbor from 'cbor';
import { canonicalManifest, type CaptureManifest } from '@justtaken/contracts';
import { verifyProof } from '../src/proof-verify';
import { hash, timestampRequest, unb64, verifyAnchors } from '../src/anchor-crypto';
async function main() {
  const anchorFixture = JSON.parse(
    await readFile('workers/api/test/fixtures/external-anchor.json', 'utf8'),
  );
  let tsaRequests = 0,
    logRequests: string[] = [],
    externalOutage = true,
    logOutage = true;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const receiptKeys = await generateKeyPair('ES256', { extractable: true });
  const signing = await exportJWK(receiptKeys.privateKey);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'test-worker',
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
          outboundService: async (request) => {
            if (request.url === 'https://timestamp.sigstore.dev/api/v1/timestamp') {
              tsaRequests++;
              assert.deepEqual(
                new Uint8Array(await request.arrayBuffer()),
                new Uint8Array(
                  timestampRequest(anchorFixture.certificate, anchorFixture.anchors.nonce),
                ),
              );
              return new Response(
                externalOutage ? 'temporarily unavailable' : unb64(anchorFixture.anchors.timestamp),
                { status: externalOutage ? 503 : 200 },
              );
            }
            if (
              request.url === 'https://rekor.sigstore.dev/api/v1/log/entries' &&
              request.method === 'POST'
            ) {
              logRequests.push(await request.text());
              return new Response(null, {
                status: logOutage ? 503 : 409,
                headers: { Location: '/api/v1/log/entries/' + 'a'.repeat(64) },
              });
            }
            if (request.url === 'https://rekor.sigstore.dev/api/v1/log/entries/' + 'a'.repeat(64))
              return Response.json({ ['a'.repeat(64)]: anchorFixture.anchors.log });
            throw new Error('Unexpected external call in isolated integration test');
          },
          bindings: {
            ENVIRONMENT: 'development',
            API_ORIGIN: 'http://test',
            APPLE_TEAM_ID: 'TEAMTEST00',
            APPLE_BUNDLE_ID: 'app.justtaken.test',
            RECEIPT_PRIVATE_JWK: JSON.stringify(signing),
            RECEIPT_KEY_ID: 'test-key',
            MEDIA_SECRET: randomBytes(32).toString('hex'),
          },
        },
      ],
    }),
  );
  let checks = 0;
  function equal(actual: unknown, expected: unknown, label: string) {
    assert.deepEqual(actual, expected, label);
    checks++;
  }
  async function call(path: string, method = 'GET', data?: unknown, access?: string) {
    const response = await mf.dispatchFetch('http://test' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(access ? { Authorization: 'Bearer ' + access } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = (await response.json()) as any;
    return { status: response.status, body };
  }
  try {
    const jwks = await call('/.well-known/capture-jwks.json');
    equal(jwks.status, 200, 'public JWK endpoint');
    equal(Object.hasOwn(jwks.body.keys[0], 'd'), false, 'private signing key is never exposed');
    const db = await mf.getD1Database('HOME');
    for (const name of (await readdir('workers/api/migrations/home'))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const source = await readFile('workers/api/migrations/home/' + name, 'utf8');
      // Keep trigger blocks together; D1 exec accepts one complete statement per line.
      const statements: string[] = [];
      let current = '';
      let trigger = false;
      for (const line of source.split('\n')) {
        if (line.trim().startsWith('--') || !line.trim()) continue;
        current += line + ' ';
        if (/^CREATE TRIGGER/.test(current.trim())) trigger = true;
        if ((!trigger && line.trim().endsWith(';')) || (trigger && line.trim() === 'END;')) {
          statements.push(current.trim());
          current = '';
          trigger = false;
        }
      }
      for (const statement of statements) await db.prepare(statement).run();
    }
    // Landing-page registration uses real D1, without app authentication or email delivery.
    async function register(data: unknown, method = 'POST', origin: string | null = 'http://test') {
      const response = await mf.dispatchFetch('http://test/public/early-access', {
        method,
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: typeof data === 'string' ? data : JSON.stringify(data),
      });
      equal(response.headers.get('cache-control'), 'no-store', 'registration is never cached');
      return { status: response.status, body: await response.json<any>() };
    }
    const signupData = {
      email: '  Early@Example.Invalid  ',
      platform: 'ios',
      consent: true,
      website: '',
    };
    equal((await register(signupData, 'POST', null)).status, 403, 'registration requires Origin');
    equal(
      (await register(signupData, 'POST', 'https://other.invalid')).status,
      403,
      'foreign origin blocked',
    );
    equal((await call('/public/early-access')).status, 405, 'no email listing endpoint');
    for (const [patch, code] of [
      [{ email: 'invalid' }, 'INVALID_EMAIL'],
      [{ consent: false }, 'CONSENT_REQUIRED'],
      [{ platform: 'desktop' }, 'INVALID_PLATFORM'],
    ] as const) {
      const result = await register({ ...signupData, ...patch });
      equal(result.status, 400, 'bad registration rejected');
      equal(result.body.error.code, code, 'specific validation failure');
    }
    equal((await register('x'.repeat(4097))).status, 413, 'bounded registration body');
    equal(
      (await register('{"email":"a@b.test","email":"b@c.test"}')).status,
      400,
      'ambiguous JSON rejected',
    );
    const accepted = await register(signupData);
    equal(accepted.status, 202, 'registration accepted');
    equal(accepted.body.accepted, true, 'explicit registration result');
    equal(
      /^[A-Za-z0-9_-]{43}$/.test(accepted.body.cancellationToken),
      true,
      'strong cancellation secret',
    );
    const saved = await db.prepare('SELECT * FROM early_access_registrations').first<any>();
    equal(saved.email, 'early@example.invalid', 'email normalized');
    equal(saved.platform, 'ios', 'platform stored');
    equal(saved.consent_version, '2026-10-25.2', 'consent version recorded');
    equal(saved.expires_at - saved.created_at, 180 * 86400000, '180 day retention');
    equal(
      saved.cancellation_hash,
      createHash('sha256').update(accepted.body.cancellationToken).digest('hex'),
      'only hash persisted',
    );
    equal(
      JSON.stringify(saved).includes(accepted.body.cancellationToken),
      false,
      'secret not persisted',
    );
    const duplicate = await register({ ...signupData, platform: 'android' });
    equal(duplicate.status, 202, 'duplicate has same envelope');
    equal(Object.keys(duplicate.body), Object.keys(accepted.body), 'no email enumeration');
    equal(
      (await register({ cancellationToken: duplicate.body.cancellationToken }, 'DELETE')).status,
      200,
      'unknown cancellation idempotent',
    );
    equal(
      await db.prepare('SELECT * FROM early_access_registrations').first(),
      saved,
      'duplicate cannot overwrite or cancel owner registration',
    );
    const bot = await register({
      ...signupData,
      email: 'bot@example.invalid',
      website: 'https://spam.invalid',
    });
    equal(bot.status, 202, 'honeypot is opaque');
    equal(
      (await db.prepare('SELECT COUNT(*) AS count FROM early_access_registrations').first<any>())
        .count,
      1,
      'honeypot not persisted',
    );
    equal(
      (await register({ cancellationToken: 'bad' }, 'DELETE')).status,
      400,
      'malformed cancellation rejected',
    );
    equal(
      (await register({ cancellationToken: accepted.body.cancellationToken }, 'DELETE')).body
        .cancelled,
      true,
      'owner cancellation accepted',
    );
    equal(
      (await db.prepare('SELECT COUNT(*) AS count FROM early_access_registrations').first<any>())
        .count,
      0,
      'owner record deleted',
    );
    equal(
      (await register({ cancellationToken: accepted.body.cancellationToken }, 'DELETE')).status,
      200,
      'repeat cancellation idempotent',
    );
    await register({ ...signupData, email: 'expired@example.invalid' });
    await register({ ...signupData, email: 'active@example.invalid' });
    await db
      .prepare(
        "UPDATE early_access_registrations SET expires_at=0 WHERE email='expired@example.invalid'",
      )
      .run();
    const sessionId = randomUUID(),
      installationId = randomUUID(),
      secret = randomBytes(32).toString('base64url'),
      refresh = randomBytes(32).toString('base64url');
    const bearer = sessionId + '.' + secret;
    equal(
      (
        await call('/__fixture/seed', 'POST', {
          sessionId,
          installationId,
          userId: 'test_user',
          access: secret,
          refresh,
          publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        })
      ).status,
      200,
      'fixture seeded',
    );
    equal((await call('/v1/me', 'GET', undefined, bearer)).status, 200, 'authenticated request');
    equal((await call('/v1/posts', 'POST', {}, 'fake')).status, 401, 'forged authentication');
    const issued = await call('/v1/capture-sessions', 'POST', { installationId }, bearer);
    equal(issued.status, 201, 'issue online nonce');
    const binding = issued.body,
      prefix = `/v1/installations/${installationId}/captures/${binding.sessionId}`;
    const jpeg = await readFile('workers/api/test/fixtures/normalized.jpg');
    const digest = createHash('sha256').update(jpeg).digest('hex');
    const manifest: CaptureManifest = {
      version: 1,
      policyVersion: 'capture-v1',
      sessionId: binding.sessionId,
      installationId,
      accountBindingId: binding.accountBindingId,
      nonce: binding.nonce,
      clientCaptureId: randomUUID(),
      clientCapturedAt: new Date().toISOString(),
      kind: 'photo',
      assets: ['original', 'thumbnail'].map((role) => ({
        id: role,
        role,
        mime: 'image/jpeg',
        bytes: jpeg.length,
        width: 8,
        height: 8,
        sha256: digest,
      })) as CaptureManifest['assets'],
    };
    function proof(m: CaptureManifest, counter: number) {
      const auth = Buffer.alloc(37);
      createHash('sha256').update('TEAMTEST00.app.justtaken.test').digest().copy(auth);
      auth[32] = 1;
      auth.writeUInt32BE(counter, 33);
      const payload = createHash('sha256')
        .update('CAPTURE_SNS_V1\0' + canonicalManifest(m))
        .digest();
      const nonce = createHash('sha256')
        .update(Buffer.concat([auth, payload]))
        .digest();
      return {
        keyId: 'fixture-key',
        assertion: cbor
          .encode({ authenticatorData: auth, signature: sign('sha256', nonce, privateKey) })
          .toString('base64'),
      };
    }
    const commitData = { manifest, proof: proof(manifest, 1) };
    equal(
      (await call('/v1/proofs', 'POST', { installationId, captureId: binding.sessionId }, bearer))
        .status,
      409,
      'unverified capture cannot issue standalone proof',
    );
    equal(
      (
        await call(
          prefix + '/commit',
          'POST',
          { manifest, proof: { keyId: 'fixture-key', assertion: 'AAAA' } },
          bearer,
        )
      ).status,
      403,
      'invalid signature fails',
    );
    const committed = await call(prefix + '/commit', 'POST', commitData, bearer);
    equal(committed.status, 200, 'valid cryptographic assertion commits');
    const replay = await call(prefix + '/commit', 'POST', { manifest, proof: {} }, bearer);
    equal(replay.body, committed.body, 'retry before external verifier');
    equal(
      (
        await call(
          prefix + '/commit',
          'POST',
          { manifest: { ...manifest, clientCaptureId: randomUUID() }, proof: {} },
          bearer,
        )
      ).status,
      409,
      'conflicting replay',
    );
    equal(
      (await call(prefix + '/complete', 'POST', {}, bearer)).status,
      409,
      'incomplete upload cannot verify',
    );
    const bad = Buffer.from(jpeg);
    bad[bad.length - 1] ^= 1;
    const corrupt = await mf.dispatchFetch('http://test' + prefix + '/assets/original', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + bearer,
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bad.length),
      },
      body: bad,
    });
    equal(corrupt.status, 422, 'R2 rejects a wrong checksum');
    for (const asset of manifest.assets) {
      const res = await mf.dispatchFetch('http://test' + prefix + '/assets/' + asset.id, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + bearer,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(jpeg.length),
        },
        body: jpeg,
      });
      equal(res.status, 200, 'upload ' + asset.id);
    }
    const verified = await call(prefix + '/complete', 'POST', {}, bearer);
    equal(verified.status, 200, 'same-stream finalization');
    equal(verified.body.state, 'VERIFIED', 'verified after all assets');
    const verifiedAgain = await call(prefix + '/complete', 'POST', {}, bearer);
    equal(verifiedAgain.body.receipt, verified.body.receipt, 'immutable receipt on retries');
    const checked = await compactVerify(verified.body.receipt, receiptKeys.publicKey);
    equal(
      JSON.parse(new TextDecoder().decode(checked.payload)).manifestDigest,
      committed.body.manifestDigest,
      'signed receipt binds manifest',
    );
    // Standalone proof: no post exists, and no anonymous original is exposed.
    const certified = await call(
      '/v1/proofs',
      'POST',
      { installationId, captureId: binding.sessionId },
      bearer,
    );
    equal(certified.status, 201, 'issue proof without SNS post');
    const standaloneId = certified.body.proof.proofId;
    const certificate = await verifyProof(certified.body.bundle, 'http://test', jwks.body);
    equal(certificate.anchorPolicy, 'rfc3161-rekor-v1', 'external evidence requirement is signed');
    equal(
      certified.body.anchoring.state,
      'not-configured',
      'disabled external provider is never reported anchored',
    );
    equal(certificate.original.sha256, digest, 'portable proof binds original');
    equal(
      certificate.evidence.deviceEnvironment,
      'test',
      'test attestation never labeled production',
    );
    equal(certificate.evidence.serviceEnvironment, 'development', 'service environment signed');
    equal(certificate.subjectTruthGuaranteed, false, 'no assertion of real-world truth');
    await call('/__fixture/patch-capture', 'POST', {
      installationId,
      captureId: binding.sessionId,
      patch: { committedAt: '2026-01-01T00:00:00.000Z' },
    });
    equal(
      (await call(`/v1/proofs/${standaloneId}`, 'GET', undefined, bearer)).status,
      409,
      'operator modifying stored capture time is detected',
    );
    await call('/__fixture/patch-capture', 'POST', {
      installationId,
      captureId: binding.sessionId,
      patch: {
        committedAt: certificate.serverCommittedAt,
        manifest: { ...manifest, clientCapturedAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    equal(
      (await call(`/v1/proofs/${standaloneId}`, 'GET', undefined, bearer)).status,
      409,
      'operator modifying manifest while retaining old digest is detected',
    );
    await call('/__fixture/patch-capture', 'POST', {
      installationId,
      captureId: binding.sessionId,
      patch: { manifest },
    });
    equal(
      (await call(`/v1/proofs/${standaloneId}`, 'GET', undefined, bearer)).status,
      200,
      'original capture record still verifies after test restoration',
    );
    for (const privateField of [
      'nonce',
      'installationId',
      'accountBindingId',
      'userId',
      'location',
    ])
      equal(Object.hasOwn(certificate, privateField), false, `proof omits ${privateField}`);
    equal(
      (await db.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>())!.n,
      0,
      'certification creates no SNS row',
    );
    equal(
      (await call('/v1/proofs', 'POST', { installationId, captureId: binding.sessionId }, bearer))
        .body.bundle,
      certified.body.bundle,
      'idempotent certificate on retry',
    );
    const proofList = await call('/v1/proofs', 'GET', undefined, bearer);
    equal(proofList.body.proofs[0].proof.proofId, standaloneId, 'standalone proof vault');
    const shareResult = await call(`/v1/proofs/${standaloneId}/shares`, 'POST', {}, bearer);
    equal(shareResult.status, 201, 'proof-only share link');
    const publicLink = new URL(shareResult.body.url);
    equal(publicLink.pathname, '/verify', 'share opens independent verifier');
    equal(publicLink.search, '', 'no token in HTTP query');
    const [shareId, shareSecret] = publicLink.hash.slice(1).split('.');
    async function openProofShare(id = shareId, secret = shareSecret) {
      return mf.dispatchFetch('http://test/public/proof-shares/' + id, {
        method: 'POST',
        headers: { 'X-Proof-Token': secret },
      });
    }
    const shareRow = await db
      .prepare('SELECT token_hash FROM proof_shares WHERE share_id=?')
      .bind(shareId)
      .first<{ token_hash: string }>();
    equal(
      shareRow!.token_hash,
      createHash('sha256').update(shareSecret).digest('hex'),
      'share token stored as hash only',
    );
    equal((await openProofShare()).status, 200, 'recipient needs no SNS login');
    equal(
      ((await (await openProofShare()).json()) as any).bundle,
      certified.body.bundle,
      'recipient receives signed certificate only',
    );
    equal((await openProofShare(shareId, 'A'.repeat(43))).status, 404, 'wrong capability rejected');
    equal(
      (await call(`/v1/proofs/${standaloneId}/original`)).status,
      401,
      'no anonymous original download',
    );
    const exported = await mf.dispatchFetch(`http://test/v1/proofs/${standaloneId}/original`, {
      headers: { Authorization: 'Bearer ' + bearer },
    });
    equal(Buffer.from(await exported.arrayBuffer()), jpeg, 'owner original export unchanged');
    equal(
      (await call(`/v1/proofs/${standaloneId}/shares`, 'POST', { days: 365 }, bearer)).status,
      400,
      'share expiry bounded',
    );
    await db.prepare("UPDATE profiles SET status='SUSPENDED' WHERE user_id='test_user'").run();
    equal((await openProofShare()).status, 410, 'suspended owner cannot expose proof');
    await db.prepare("UPDATE profiles SET status='ACTIVE' WHERE user_id='test_user'").run();
    await db
      .prepare('UPDATE proof_shares SET expires_at=? WHERE share_id=?')
      .bind(Date.now() - 1, shareId)
      .run();
    equal((await openProofShare()).status, 404, 'expired share rejected');
    await db
      .prepare('UPDATE proof_shares SET expires_at=? WHERE share_id=?')
      .bind(Date.now() + 86400_000, shareId)
      .run();
    equal(
      (await call(`/v1/proofs/${standaloneId}/shares`, 'DELETE', undefined, bearer)).status,
      200,
      'owner revokes share links',
    );
    equal((await openProofShare()).status, 404, 'revocation enforced');
    const newShare = (await call(`/v1/proofs/${standaloneId}/shares`, 'POST', {}, bearer)).body;
    const [newShareId, newShareSecret] = new URL(newShare.url).hash.slice(1).split('.');
    equal(
      (await openProofShare(newShareId, newShareSecret)).status,
      200,
      'new link after revocation works',
    );
    equal(
      (await verifyProof(certified.body.bundle, 'http://test', jwks.body)).proofId,
      standaloneId,
      'saved signature is not erased by link revocation',
    );
    const verifierPage = await mf.dispatchFetch('http://test/verify');
    equal(verifierPage.status, 200, 'public verification page');
    equal(
      verifierPage.headers.get('Content-Security-Policy')!.includes("frame-ancestors 'none'"),
      true,
      'verifier cannot be framed',
    );
    const created = await call(
      '/v1/posts',
      'POST',
      {
        installationId,
        captureId: binding.sessionId,
        caption: '帰り道 🌿',
        visibility: 'followers',
      },
      bearer,
    );
    equal(created.status, 201, 'post intent');
    equal(created.body.post.state, 'PROCESSING', 'moderation required');
    const postId = created.body.post.post_id;
    const viewerSession = randomUUID(),
      viewerSecret = randomBytes(32).toString('base64url'),
      viewerBearer = viewerSession + '.' + viewerSecret;
    await call('/__fixture/seed', 'POST', {
      sessionId: viewerSession,
      installationId: randomUUID(),
      userId: 'viewer',
      access: viewerSecret,
      refresh: randomBytes(32).toString('base64url'),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    });
    for (const [suffix, method] of [
      ['', 'GET'],
      ['/shares', 'POST'],
      ['/shares', 'DELETE'],
      ['/original', 'GET'],
      ['/location', 'GET'],
    ] as const)
      equal(
        (
          await call(
            `/v1/proofs/${standaloneId}${suffix}`,
            method,
            method === 'POST' ? {} : undefined,
            viewerBearer,
          )
        ).status,
        404,
        'cross-owner proof access blocked: ' + method + suffix,
      );
    equal(
      (await call('/v1/proofs', 'GET', undefined, viewerBearer)).body.proofs.length,
      0,
      'vault isolated to owner',
    );
    equal(
      (await call(prefix, 'GET', undefined, viewerBearer)).status,
      404,
      'capture bound to owner',
    );
    equal(
      (await call('/v1/posts/' + postId, 'GET', undefined, viewerBearer)).status,
      404,
      'processing post hidden from other users',
    );
    equal(
      (
        await call(
          '/v1/posts',
          'POST',
          { installationId, captureId: binding.sessionId, caption: 'public', visibility: 'public' },
          bearer,
        )
      ).status,
      409,
      'private accounts cannot publish publicly',
    );
    await db
      .prepare("INSERT INTO moderation_decisions VALUES(?,'ALLOWED','test-reviewer',?)")
      .bind(binding.sessionId, new Date().toISOString())
      .run();
    equal(
      (await call('/v1/posts/' + postId + '/publish', 'POST', {}, bearer)).body.post.state,
      'PUBLISHED',
      'publish after moderation',
    );
    equal(
      (await call('/v1/posts/' + postId, 'GET', undefined, viewerBearer)).status,
      404,
      'nonfollower denied',
    );
    await db.prepare("INSERT INTO followers(target_id,follower_id,state,revision) VALUES('test_user','viewer','PENDING',1)").run();
    equal(
      (await call('/v1/posts/' + postId, 'GET', undefined, viewerBearer)).status,
      404,
      'pending follower denied',
    );
    await db.prepare("UPDATE followers SET state='APPROVED' WHERE follower_id='viewer'").run();
    equal(
      (await call('/v1/posts/' + postId, 'GET', undefined, viewerBearer)).status,
      200,
      'approved follower allowed',
    );
    await db.prepare("INSERT INTO blocks VALUES('viewer','test_user')").run();
    equal(
      (await call('/v1/posts/' + postId, 'GET', undefined, viewerBearer)).status,
      404,
      'block in either direction wins',
    );
    const grant = await call(`/v1/posts/${postId}/media-grants`, 'POST', {}, bearer);
    equal(grant.status, 200, 'scoped media grant');
    const media = await mf.dispatchFetch('http://test' + grant.body.original, {
      headers: { Authorization: 'Bearer ' + bearer, Range: 'bytes=0-4' },
    });
    equal(media.status, 206, 'authenticated range');
    equal(Buffer.from(await media.arrayBuffer()), jpeg.subarray(0, 5), 'range bytes');
    equal((await call('/v1/posts/' + postId, 'DELETE', undefined, bearer)).status, 200, 'delete');
    equal(
      (await openProofShare(newShareId, newShareSecret)).status,
      200,
      'SNS deletion preserves independently saved proof',
    );
    equal(
      (await call(prefix, 'GET', undefined, bearer)).body.state,
      'VERIFIED',
      'SNS deletion retains vault original',
    );
    equal(
      (await call(`/v1/proofs/${standaloneId}`, 'DELETE', undefined, bearer)).status,
      200,
      'vault deletion removes original',
    );
    equal(
      (await call(`/v1/proofs/${standaloneId}`, 'DELETE', undefined, bearer)).status,
      200,
      'vault deletion is idempotent',
    );
    equal(
      (await openProofShare(newShareId, newShareSecret)).status,
      404,
      'capture deletion stops standalone proof access',
    );
    equal(
      (await call(`/v1/proofs/${standaloneId}/original`, 'GET', undefined, bearer)).status,
      409,
      'deleted original export blocked',
    );
    equal(
      (await call('/v1/posts/' + postId, 'DELETE', undefined, bearer)).status,
      200,
      'delete retries are idempotent',
    );
    const oldGrant = await mf.dispatchFetch('http://test' + grant.body.original, {
      headers: { Authorization: 'Bearer ' + bearer },
    });
    equal(oldGrant.status, 404, 'deletion revokes old grant immediately');
    equal(
      (await call(prefix + '/complete', 'POST', {}, bearer)).status,
      409,
      'cannot resurrect deleted capture',
    );
    equal(
      (await call(prefix + '/commit', 'POST', commitData, bearer)).status,
      409,
      'commit retry cannot revive tombstone',
    );
    await db.prepare("UPDATE quota_accounts SET limit_bytes=1 WHERE user_id='test_user'").run();
    const next = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer)).body;
    const nextManifest = {
      ...manifest,
      sessionId: next.sessionId,
      nonce: next.nonce,
      clientCaptureId: randomUUID(),
    };
    equal(
      (
        await call(
          `/v1/installations/${installationId}/captures/${next.sessionId}/commit`,
          'POST',
          { manifest: nextManifest, proof: proof(nextManifest, 2) },
          bearer,
        )
      ).status,
      409,
      'quota fails atomically',
    );
    equal(
      (
        (await db
          .prepare('SELECT COUNT(*) AS n FROM quota_reservations WHERE capture_id=?')
          .bind(next.sessionId)
          .first()) as any
      ).n,
      0,
      'failed quota does not leave an uncharged reservation',
    );
    await db
      .prepare("UPDATE quota_accounts SET limit_bytes=200000000 WHERE user_id='test_user'")
      .run();
    equal(
      (
        await call(
          `/v1/installations/${installationId}/captures/${next.sessionId}/commit`,
          'POST',
          { manifest: nextManifest, proof: proof(nextManifest, 2) },
          bearer,
        )
      ).status,
      200,
      'failed quota did not consume nonce/counter',
    );
    const concurrent = await Promise.all(
      [0, 1].map(async () => {
        const issued = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer))
          .body;
        const m = {
          ...manifest,
          sessionId: issued.sessionId,
          nonce: issued.nonce,
          clientCaptureId: randomUUID(),
        };
        return call(
          `/v1/installations/${installationId}/captures/${issued.sessionId}/commit`,
          'POST',
          { manifest: m, proof: proof(m, 3) },
          bearer,
        );
      }),
    );
    equal(
      concurrent.map((r) => (r.status === 403 ? 409 : r.status)).sort(),
      [200, 409],
      'concurrent assertions cannot consume the same counter',
    );
    // Real AVFoundation MP4s go through the same proof, storage, receipt and ACL routes.
    let videoCounter = 4;
    for (const name of [
      'audio',
      'silent',
      'limit',
      'original-silent',
      'original-audio',
      'original-hevc',
      'original-hdr',
      'original-limit',
    ]) {
      const bytes = await readFile(`workers/api/test/fixtures/${name}.mp4`);
      const { hasAudio, ...details } = JSON.parse(
        await readFile(`workers/api/test/fixtures/${name}.json`, 'utf8'),
      );
      const session = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer)).body;
      const video: CaptureManifest = {
        ...manifest,
        kind: 'video',
        policyVersion: name.startsWith('original-') ? 'capture-v2' : 'capture-v1',
        sessionId: session.sessionId,
        nonce: session.nonce,
        clientCaptureId: randomUUID(),
        assets: [
          {
            ...details,
            ...(hasAudio ? { audioCodec: 'aac-lc' } : {}),
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          { ...manifest.assets[1], id: 'poster', role: 'poster' },
        ],
      };
      if (video.policyVersion === 'capture-v2')
        video.location = {
          status: 'recorded',
          source: 'device-location',
          latitudeE7: 350000000,
          longitudeE7: 1390000000,
          horizontalAccuracyMm: 2500000,
          measuredAt: video.clientCapturedAt,
          accuracyAuthorization: 'approximate',
        };
      const videoPath = `/v1/installations/${installationId}/captures/${session.sessionId}`;
      const commit = { manifest: video, proof: proof(video, videoCounter++) };
      equal(
        (await call(videoPath + '/commit', 'POST', commit, bearer)).status,
        200,
        `${name}: native video manifest committed`,
      );
      equal(
        (await call(videoPath + '/commit', 'POST', commit, bearer)).status,
        200,
        `${name}: commit retry reuses proof`,
      );
      for (const a of video.assets) {
        const result = await mf.dispatchFetch('http://test' + videoPath + '/assets/' + a.id, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + bearer,
            'Content-Type': a.mime,
            'Content-Length': String(a.bytes),
          },
          body: a.id === 'original' ? bytes : jpeg,
        });
        equal(result.status, 200, `${name}: upload ${a.id}`);
      }
      const complete = await call(videoPath + '/complete', 'POST', {}, bearer);
      equal(complete.body.state, 'VERIFIED', `${name}: MP4 verified`);
      const videoProof = await call(
        '/v1/proofs',
        'POST',
        { installationId, captureId: video.sessionId },
        bearer,
      );
      equal(videoProof.status, 201, `${name}: standalone video certificate`);
      equal(
        (
          await call(
            `/v1/proofs/${videoProof.body.proof.proofId}/location`,
            'GET',
            undefined,
            bearer,
          )
        ).body.location,
        video.location ?? null,
        `${name}: owner reads capture-start GPS or legacy absence`,
      );
      equal(
        Object.hasOwn(videoProof.body.proof, 'location'),
        false,
        `${name}: video certificate omits GPS`,
      );
      const portableVideo = await verifyProof(videoProof.body.bundle, 'http://test', jwks.body);
      equal(
        portableVideo.original,
        video.assets[0],
        `${name}: video duration, HDR and audio bound to portable proof`,
      );
      equal(
        (await call(videoPath + '/complete', 'POST', {}, bearer)).body.receipt,
        complete.body.receipt,
        `${name}: immutable video receipt`,
      );
      const posted = await call(
        '/v1/posts',
        'POST',
        { installationId, captureId: session.sessionId, caption: name, visibility: 'followers' },
        bearer,
      );
      equal(posted.body.post.state, 'PROCESSING', `${name}: moderation gate retained`);
      const id = posted.body.post.post_id;
      const grant = await call(`/v1/posts/${id}/media-grants`, 'POST', {}, bearer);
      equal(grant.body.kind, 'video', `${name}: grant identifies video`);
      const range = await mf.dispatchFetch('http://test' + grant.body.original, {
        headers: { Authorization: 'Bearer ' + bearer, Range: 'bytes=10-39' },
      });
      equal(range.status, 206, `${name}: video seek range`);
      equal(range.headers.get('Content-Type'), 'video/mp4', `${name}: video MIME`);
      equal(
        Buffer.from(await range.arrayBuffer()),
        bytes.subarray(10, 40),
        `${name}: exact range bytes`,
      );
      const head = await mf.dispatchFetch('http://test' + grant.body.original, {
        method: 'HEAD',
        headers: { Authorization: 'Bearer ' + bearer },
      });
      equal(head.headers.get('Content-Length'), String(bytes.length), `${name}: HEAD length`);
      equal(
        head.headers.get('ETag'),
        '"' + video.assets[0].sha256 + '"',
        `${name}: strong video ETag`,
      );
      const invalidRange = await mf.dispatchFetch('http://test' + grant.body.original, {
        headers: { Authorization: 'Bearer ' + bearer, Range: `bytes=${bytes.length}-` },
      });
      equal(invalidRange.status, 416, `${name}: invalid video range`);
      equal(
        invalidRange.headers.get('Content-Range'),
        `bytes */${bytes.length}`,
        `${name}: 416 reports total length`,
      );
      const staleRange = await mf.dispatchFetch('http://test' + grant.body.original, {
        headers: { Authorization: 'Bearer ' + bearer, Range: 'bytes=10-39', 'If-Range': '"stale"' },
      });
      equal(staleRange.status, 200, `${name}: stale If-Range returns full representation`);
      await staleRange.body?.cancel();
      const poster = await mf.dispatchFetch('http://test' + grant.body.preview, {
        headers: { Authorization: 'Bearer ' + bearer },
      });
      equal(poster.headers.get('Content-Type'), 'image/jpeg', `${name}: poster MIME`);
      await poster.body?.cancel();
      equal(
        (await call(`/v1/posts/${id}`, 'GET', undefined, viewerBearer)).status,
        404,
        `${name}: video ACL enforced`,
      );
      const record = await call(`/v1/posts/${id}/record`, 'GET', undefined, bearer);
      equal(
        record.body.manifest.assets[0].audioCodec,
        hasAudio ? 'aac-lc' : undefined,
        `${name}: audio bound to proof`,
      );
      const receipt = await compactVerify(complete.body.receipt, receiptKeys.publicKey);
      equal(
        JSON.parse(new TextDecoder().decode(receipt.payload)).manifestDigest,
        createHash('sha256')
          .update('CAPTURE_SNS_V1\0' + canonicalManifest(video))
          .digest('hex'),
        `${name}: receipt covers video manifest`,
      );
      await call(`/v1/posts/${id}`, 'DELETE', undefined, bearer);
      await call(`/v1/proofs/${videoProof.body.proof.proofId}`, 'DELETE', undefined, bearer);
      equal(
        (
          await mf.dispatchFetch('http://test' + grant.body.original, {
            headers: { Authorization: 'Bearer ' + bearer },
          })
        ).status,
        404,
        `${name}: deletion revokes video`,
      );
    }
    // Original JPEG: full-resolution, orientation and ICC survive attestation -> storage -> post.
    const originalPhoto = await readFile('workers/api/test/fixtures/original-photo.jpg');
    const photoSession = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer))
      .body;
    const photoV2: CaptureManifest = {
      ...manifest,
      policyVersion: 'capture-v2',
      sessionId: photoSession.sessionId,
      nonce: photoSession.nonce,
      clientCaptureId: randomUUID(),
      assets: [
        {
          ...manifest.assets[0],
          bytes: originalPhoto.length,
          width: 4032,
          height: 3024,
          orientation: 6,
          sha256: createHash('sha256').update(originalPhoto).digest('hex'),
        },
        manifest.assets[1],
      ],
    };
    photoV2.location = {
      status: 'recorded',
      source: 'device-location',
      latitudeE7: 350000000,
      longitudeE7: 1390000000,
      horizontalAccuracyMm: 5000,
      measuredAt: photoV2.clientCapturedAt,
      accuracyAuthorization: 'precise',
    };
    const photoPath = `/v1/installations/${installationId}/captures/${photoSession.sessionId}`;
    equal(
      (
        await call(
          photoPath + '/commit',
          'POST',
          {
            manifest: { ...photoV2, location: { ...photoV2.location, latitudeE7: 360000000 } },
            proof: proof(photoV2, videoCounter),
          },
          bearer,
        )
      ).status,
      403,
      'changed GPS invalidates native attestation',
    );
    equal(
      (
        await call(
          photoPath + '/commit',
          'POST',
          { manifest: photoV2, proof: proof(photoV2, videoCounter++) },
          bearer,
        )
      ).status,
      200,
      'original JPEG committed',
    );
    for (const asset of photoV2.assets)
      equal(
        (
          await mf.dispatchFetch('http://test' + photoPath + '/assets/' + asset.id, {
            method: 'PUT',
            headers: {
              Authorization: 'Bearer ' + bearer,
              'Content-Type': asset.mime,
              'Content-Length': String(asset.bytes),
            },
            body: asset.id === 'original' ? originalPhoto : jpeg,
          })
        ).status,
        200,
        'original JPEG asset uploaded',
      );
    equal(
      (await call(photoPath + '/complete', 'POST', {}, bearer)).body.state,
      'VERIFIED',
      'full JPEG orientation and pixels verified',
    );
    const gpsProof = (
      await call(
        '/v1/proofs',
        'POST',
        { installationId, captureId: photoSession.sessionId },
        bearer,
      )
    ).body;
    const gpsId = gpsProof.proof.proofId;
    const locationPath = `/v1/proofs/${gpsId}/location`;
    equal(
      (await call(locationPath, 'GET', undefined, bearer)).body.location,
      photoV2.location,
      'GPS owner reads original native sample',
    );
    equal((await call(locationPath)).status, 401, 'GPS requires login');
    equal(
      (await call(locationPath, 'GET', undefined, viewerBearer)).status,
      404,
      'GPS denied to another account',
    );
    equal(
      JSON.stringify(gpsProof).includes('latitudeE7'),
      false,
      'portable proof bundle contains no coordinates',
    );
    const gpsShare = (await call(`/v1/proofs/${gpsId}/shares`, 'POST', {}, bearer)).body;
    const [gpsShareID, gpsSecret] = new URL(gpsShare.url).hash.slice(1).split('.');
    const gpsPublic = await mf.dispatchFetch('http://test/public/proof-shares/' + gpsShareID, {
      method: 'POST',
      headers: { 'X-Proof-Token': gpsSecret },
    });
    equal(gpsPublic.status, 200, 'GPS capture can share privacy-safe certificate');
    equal((await gpsPublic.text()).includes('latitudeE7'), false, 'public share never returns GPS');
    await call('/__fixture/patch-capture', 'POST', {
      installationId,
      captureId: photoSession.sessionId,
      patch: {
        manifest: { ...photoV2, location: { ...photoV2.location, longitudeE7: 1380000000 } },
      },
    });
    equal(
      (await call(locationPath, 'GET', undefined, bearer)).status,
      409,
      'operator GPS change detected against signed manifest commitment',
    );
    await call('/__fixture/patch-capture', 'POST', {
      installationId,
      captureId: photoSession.sessionId,
      patch: { manifest: photoV2 },
    });
    equal(
      (await call(locationPath, 'GET', undefined, bearer)).body.location,
      photoV2.location,
      'restored GPS agrees with signed record',
    );
    const photoPost = (
      await call(
        '/v1/posts',
        'POST',
        {
          installationId,
          captureId: photoSession.sessionId,
          caption: 'original photo',
          visibility: 'private',
        },
        bearer,
      )
    ).body.post;
    const photoGrant = (
      await call(`/v1/posts/${photoPost.post_id}/media-grants`, 'POST', {}, bearer)
    ).body;
    const servedPhoto = await mf.dispatchFetch('http://test' + photoGrant.original, {
      headers: { Authorization: 'Bearer ' + bearer },
    });
    equal(
      Buffer.from(await servedPhoto.arrayBuffer()),
      originalPhoto,
      'original JPEG served byte-for-byte',
    );
    equal(photoGrant.preview.includes('/thumbnail?'), true, 'photo feed uses separate thumbnail');
    equal(JSON.stringify(photoPost).includes('latitudeE7'), false, 'SNS post does not expose GPS');
    equal(
      (await call('/v1/proofs', 'GET', undefined, viewerBearer)).body.proofs.some(
        (entry: any) => entry.proof.proofId === gpsId,
      ),
      false,
      'GPS vault stays isolated',
    );
    equal(
      (
        await call('/__fixture/has-location', 'POST', {
          installationId,
          captureId: photoSession.sessionId,
        })
      ).body.present,
      true,
      'location persisted before owner deletes capture',
    );
    await call(`/v1/proofs/${gpsId}`, 'DELETE', undefined, bearer);
    equal(
      (
        await call('/__fixture/has-location', 'POST', {
          installationId,
          captureId: photoSession.sessionId,
        })
      ).body.present,
      false,
      'owner deletion removes coordinates from current stored record',
    );
    equal(
      (await call(locationPath, 'GET', undefined, bearer)).status,
      409,
      'deleted capture no longer exposes GPS',
    );
    await call(`/v1/posts/${photoPost.post_id}`, 'DELETE', undefined, bearer);

    // Padding is test-only: valid free box creates a >8 MiB MP4 without a giant committed fixture.
    const sourceVideo = await readFile('workers/api/test/fixtures/original-hevc.mp4');
    const { hasAudio: paddedAudio, ...paddedDetails } = JSON.parse(
      await readFile('workers/api/test/fixtures/original-hevc.json', 'utf8'),
    );
    const padding = Buffer.alloc(8_388_608 + 64);
    padding.writeUInt32BE(padding.length);
    padding.write('free', 4, 'ascii');
    const multipartBytes = Buffer.concat([sourceVideo, padding]);
    const partBytes = 8_388_608;
    async function newMultipart(wrongHash = false) {
      const binding = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer)).body;
      const capture: CaptureManifest = {
        ...manifest,
        policyVersion: 'capture-v2',
        kind: 'video',
        sessionId: binding.sessionId,
        nonce: binding.nonce,
        clientCaptureId: randomUUID(),
        assets: [
          {
            ...paddedDetails,
            bytes: multipartBytes.length,
            sha256: wrongHash
              ? 'f'.repeat(64)
              : createHash('sha256').update(multipartBytes).digest('hex'),
          },
          { ...manifest.assets[1], id: 'poster', role: 'poster' },
        ],
      };
      const path = `/v1/installations/${installationId}/captures/${binding.sessionId}`;
      equal(
        (
          await call(
            path + '/commit',
            'POST',
            { manifest: capture, proof: proof(capture, videoCounter++) },
            bearer,
          )
        ).status,
        200,
        'multipart manifest committed',
      );
      return { path, capture, assetPath: path + '/assets/original' };
    }
    async function sendPart(
      path: string,
      number: number,
      override?: { digest?: string; short?: boolean },
    ) {
      const chunk = multipartBytes.subarray(
        (number - 1) * partBytes,
        Math.min(number * partBytes, multipartBytes.length),
      );
      const data = override?.short ? chunk.subarray(0, -1) : chunk;
      const response = await mf.dispatchFetch('http://test' + path + '/parts/' + number, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + bearer,
          'Content-Type': 'video/mp4',
          'Content-Length': String(data.length),
          'X-Chunk-SHA256': override?.digest ?? createHash('sha256').update(chunk).digest('hex'),
        },
        body: data,
      });
      await response.body?.cancel();
      return response.status;
    }
    const multi = await newMultipart();
    equal(
      (await call(multi.assetPath + '/multipart', 'POST', {}, viewerBearer)).status,
      404,
      'multipart refuses another account',
    );
    const started = await call(multi.assetPath + '/multipart', 'POST', {}, bearer);
    equal(started.body.partBytes, partBytes, 'server chooses bounded 8 MiB parts');
    equal(
      (await call(multi.assetPath + '/uploaded', 'POST', {}, bearer)).status,
      409,
      'incomplete multipart cannot finish',
    );
    equal(
      await sendPart(multi.assetPath, 1, { digest: '0'.repeat(64) }),
      422,
      'corrupt chunk rejected before record',
    );
    equal(
      (await call(multi.assetPath + '/multipart', 'POST', {}, bearer)).body.uploadedParts,
      [],
      'bad chunk is not resumable',
    );
    equal(await sendPart(multi.assetPath, 1), 200, 'first chunk uploaded');
    equal(
      (await call(multi.assetPath + '/multipart', 'POST', {}, bearer)).body.uploadedParts,
      [1],
      'restart resumes previously accepted chunks',
    );
    equal(await sendPart(multi.assetPath, 1), 200, 'same chunk retry is idempotent');
    equal(
      await sendPart(multi.assetPath, 1, { digest: 'e'.repeat(64) }),
      409,
      'accepted part cannot change digest',
    );
    equal(
      await sendPart(multi.assetPath, 2, { short: true }),
      400,
      'incorrect part length rejected',
    );
    for (let n = 2; n <= started.body.totalParts; n++)
      equal(await sendPart(multi.assetPath, n), 200, 'remaining part uploaded');
    equal(
      (await call(multi.assetPath + '/uploaded', 'POST', {}, bearer)).status,
      200,
      'R2 multipart assembled',
    );
    equal(
      (await call(multi.assetPath + '/uploaded', 'POST', {}, bearer)).status,
      200,
      'R2 multipart completion retry',
    );
    equal(
      (await call(multi.assetPath + '/multipart', 'POST', {}, bearer)).body.complete,
      true,
      'completed upload survives restart',
    );
    await mf.dispatchFetch('http://test' + multi.path + '/assets/poster', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + bearer,
        'Content-Type': 'image/jpeg',
        'Content-Length': String(jpeg.length),
      },
      body: jpeg,
    });
    equal(
      (await call(multi.path + '/complete', 'POST', {}, bearer)).body.state,
      'VERIFIED',
      'whole-file hash and HEVC inspected after multipart',
    );
    const multipartPost = (
      await call(
        '/v1/posts',
        'POST',
        {
          installationId,
          captureId: multi.capture.sessionId,
          caption: 'multipart',
          visibility: 'private',
        },
        bearer,
      )
    ).body.post;
    const multipartGrant = (
      await call(`/v1/posts/${multipartPost.post_id}/media-grants`, 'POST', {}, bearer)
    ).body;
    const servedMulti = await mf.dispatchFetch('http://test' + multipartGrant.original, {
      headers: { Authorization: 'Bearer ' + bearer },
    });
    equal(
      createHash('sha256')
        .update(Buffer.from(await servedMulti.arrayBuffer()))
        .digest('hex'),
      multi.capture.assets[0].sha256,
      'multipart post serves exactly the attested original',
    );
    await call(`/v1/posts/${multipartPost.post_id}`, 'DELETE', undefined, bearer);

    const forged = await newMultipart(true);
    await call(forged.assetPath + '/multipart', 'POST', {}, bearer);
    for (let n = 1; n <= Math.ceil(multipartBytes.length / partBytes); n++)
      await sendPart(forged.assetPath, n);
    await call(forged.assetPath + '/uploaded', 'POST', {}, bearer);
    equal(
      (await call(forged.path + '/complete', 'POST', {}, bearer)).status,
      422,
      'multipart metadata cannot bypass whole-file SHA256',
    );
    await call(forged.path, 'DELETE', undefined, bearer);
    const cancelled = await newMultipart();
    await call(cancelled.assetPath + '/multipart', 'POST', {}, bearer);
    await sendPart(cancelled.assetPath, 1);
    equal(
      (await call(cancelled.path, 'DELETE', undefined, bearer)).status,
      200,
      'cancel aborts incomplete multipart',
    );
    equal(
      (await call(cancelled.assetPath + '/multipart', 'POST', {}, bearer)).status,
      409,
      'cancelled capture cannot resume',
    );
    equal(await sendPart(cancelled.assetPath, 2), 409, 'late part cannot resurrect capture');

    const expiredMultipart = await newMultipart();
    await call(expiredMultipart.assetPath + '/multipart', 'POST', {}, bearer);
    await sendPart(expiredMultipart.assetPath, 1);
    await call('/__fixture/expire', 'POST', {
      installationId,
      captureId: expiredMultipart.capture.sessionId,
    });
    equal(
      (await call(expiredMultipart.assetPath + '/multipart', 'POST', {}, bearer)).status,
      409,
      'expired upload cannot resume',
    );
    equal(await sendPart(expiredMultipart.assetPath, 2), 409, 'expired upload refuses later parts');
    equal(
      (await call(expiredMultipart.assetPath + '/uploaded', 'POST', {}, bearer)).status,
      409,
      'expired upload cannot finish',
    );
    equal(
      (await call(expiredMultipart.path + '/complete', 'POST', {}, bearer)).status,
      409,
      'expired upload cannot receive receipt',
    );
    await call(expiredMultipart.path, 'DELETE', undefined, bearer);
    // v3 camera containers keep every source byte, including HEIF/RAW/HDR metadata.
    for (const name of [
      'heif-sdr',
      'heif-hdr',
      'jpeg-hdr',
      'bayer-dng',
      'linear-dng',
      'heif-sdr-large',
      'heif-hdr-large',
      'jpeg-hdr-large',
    ]) {
      const details = JSON.parse(await readFile(`workers/api/test/fixtures/${name}.json`, 'utf8'));
      const bytes = await readFile(
        `workers/api/test/fixtures/${name}.${name.startsWith('heif') ? 'heic' : name.includes('dng') ? 'dng' : 'jpg'}`,
      );
      const issued = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer)).body;
      const capture: CaptureManifest = {
        ...manifest,
        policyVersion: 'capture-v3',
        sessionId: issued.sessionId,
        nonce: issued.nonce,
        clientCaptureId: randomUUID(),
        assets: [
          { ...details, sha256: createHash('sha256').update(bytes).digest('hex') },
          manifest.assets[1],
        ],
      };
      const path = `/v1/installations/${installationId}/captures/${capture.sessionId}`;
      equal(
        (
          await call(
            path + '/commit',
            'POST',
            { manifest: capture, proof: proof(capture, videoCounter++) },
            bearer,
          )
        ).status,
        200,
        `${name}: original manifest bound to device assertion`,
      );
      for (const a of capture.assets)
        equal(
          (
            await mf.dispatchFetch('http://test' + path + '/assets/' + a.id, {
              method: 'PUT',
              headers: {
                Authorization: 'Bearer ' + bearer,
                'Content-Type': a.mime,
                'Content-Length': String(a.bytes),
              },
              body: a.id === 'original' ? bytes : jpeg,
            })
          ).status,
          200,
          `${name}: upload`,
        );
      equal(
        (await call(path + '/complete', 'POST', {}, bearer)).body.state,
        'VERIFIED',
        `${name}: complete validates original and issues receipt`,
      );
      equal(
        (await call(path + '/complete', 'POST', {}, bearer)).body.state,
        'VERIFIED',
        `${name}: completion retry`,
      );
      const portable = await call(
        '/v1/proofs',
        'POST',
        { installationId, captureId: capture.sessionId },
        bearer,
      );
      equal(portable.status, 201, `${name}: standalone original-format proof`);
      const publicProof = await verifyProof(portable.body.bundle, 'http://test', jwks.body);
      equal(
        publicProof.original,
        capture.assets[0],
        `${name}: all original format fields bound to certificate`,
      );
      const exportedOriginal = await mf.dispatchFetch(
        `http://test/v1/proofs/${publicProof.proofId}/original`,
        {
          headers: { Authorization: 'Bearer ' + bearer },
        },
      );
      equal(
        Buffer.from(await exportedOriginal.arrayBuffer()),
        bytes,
        `${name}: standalone original export preserves every byte`,
      );
      const post = (
        await call(
          '/v1/posts',
          'POST',
          { installationId, captureId: capture.sessionId, caption: name, visibility: 'private' },
          bearer,
        )
      ).body.post;
      equal(post.state, 'PROCESSING', `${name}: photo post retains moderation gate`);
      const grant = (await call(`/v1/posts/${post.post_id}/media-grants`, 'POST', {}, bearer)).body;
      equal(
        grant.originalFormat,
        { mime: details.mime, hasGainMap: details.hasGainMap, preservation: 'camera-original' },
        `${name}: truthful format in media grant`,
      );
      const response = await mf.dispatchFetch('http://test' + grant.original, {
        headers: { Authorization: 'Bearer ' + bearer },
      });
      equal(response.status, 200, `${name}: original accessible to owner`);
      equal(
        response.headers.get('Content-Type'),
        details.mime,
        `${name}: original MIME is unchanged`,
      );
      equal(
        Buffer.from(await response.arrayBuffer()),
        bytes,
        `${name}: complete uploaded file is byte-for-byte identical after posting`,
      );
      const record = (await call(`/v1/posts/${post.post_id}/record`, 'GET', undefined, bearer))
        .body;
      equal(
        record.manifest.assets[0],
        capture.assets[0],
        `${name}: original SHA256, orientation and HDR bound to record`,
      );
      await call(`/v1/posts/${post.post_id}`, 'DELETE', undefined, bearer);
      await call(`/v1/proofs/${publicProof.proofId}`, 'DELETE', undefined, bearer);
    }
    // A valid synthetic 9 MiB RAW crosses the multipart boundary without transcoding.
    {
      const small = await readFile('workers/api/test/fixtures/bayer-dng.dng');
      const count = small.readUInt16LE(8),
        entries = new Map<number, number>();
      for (let i = 0; i < count; i++) entries.set(small.readUInt16LE(10 + i * 12), 10 + i * 12);
      const pixelOffset = small.readUInt32LE(entries.get(273)! + 8),
        width = 2048,
        height = 2304;
      const bytes = Buffer.alloc(pixelOffset + width * height * 2, 1);
      small.copy(bytes, 0, 0, pixelOffset);
      bytes.writeUInt32LE(width, entries.get(256)! + 8);
      bytes.writeUInt32LE(height, entries.get(257)! + 8);
      bytes.writeUInt32LE(height, entries.get(278)! + 8);
      bytes.writeUInt32LE(width * height * 2, entries.get(279)! + 8);
      const crop = bytes.readUInt32LE(entries.get(50720)! + 8);
      bytes.writeUInt32LE(width, crop);
      bytes.writeUInt32LE(height, crop + 4);
      const details = JSON.parse(
        await readFile('workers/api/test/fixtures/bayer-dng.json', 'utf8'),
      );
      const issued = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer)).body;
      const capture: CaptureManifest = {
        ...manifest,
        policyVersion: 'capture-v3',
        sessionId: issued.sessionId,
        nonce: issued.nonce,
        clientCaptureId: randomUUID(),
        assets: [
          {
            ...details,
            width,
            height,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          manifest.assets[1],
        ],
      };
      const path = `/v1/installations/${installationId}/captures/${capture.sessionId}`,
        assetPath = path + '/assets/original';
      equal(
        (
          await call(
            path + '/commit',
            'POST',
            { manifest: capture, proof: proof(capture, videoCounter++) },
            bearer,
          )
        ).status,
        200,
        'large RAW manifest',
      );
      const state = (await call(assetPath + '/multipart', 'POST', {}, bearer)).body;
      equal(state.totalParts, 2, 'RAW uses multipart without reducing image quality');
      for (let i = 1; i <= state.totalParts; i++) {
        const part = bytes.subarray((i - 1) * partBytes, Math.min(i * partBytes, bytes.length));
        const response = await mf.dispatchFetch('http://test' + assetPath + '/parts/' + i, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + bearer,
            'Content-Type': 'image/x-adobe-dng',
            'Content-Length': String(part.length),
            'X-Chunk-SHA256': createHash('sha256').update(part).digest('hex'),
          },
          body: part,
        });
        equal(response.status, 200, 'RAW part accepted');
        await response.body?.cancel();
        if (i === 1)
          equal(
            (await call(assetPath + '/multipart', 'POST', {}, bearer)).body.uploadedParts,
            [1],
            'RAW transfer resumes with existing part',
          );
      }
      equal(
        (await call(assetPath + '/uploaded', 'POST', {}, bearer)).status,
        200,
        'RAW multipart assembled',
      );
      await mf.dispatchFetch('http://test' + path + '/assets/thumbnail', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + bearer,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(jpeg.length),
        },
        body: jpeg,
      });
      equal(
        (await call(path + '/complete', 'POST', {}, bearer)).body.state,
        'VERIFIED',
        'RAW metadata and full SHA256 verified after multipart',
      );
      const post = (
        await call(
          '/v1/posts',
          'POST',
          {
            installationId,
            captureId: capture.sessionId,
            caption: 'RAW multipart',
            visibility: 'private',
          },
          bearer,
        )
      ).body.post;
      const grant = (await call(`/v1/posts/${post.post_id}/media-grants`, 'POST', {}, bearer)).body;
      const response = await mf.dispatchFetch('http://test' + grant.original, {
        headers: { Authorization: 'Bearer ' + bearer },
      });
      equal(
        Buffer.from(await response.arrayBuffer()),
        bytes,
        'multipart RAW post keeps complete DNG byte-for-byte',
      );
      await call(`/v1/posts/${post.post_id}`, 'DELETE', undefined, bearer);
    }
    // A checksum-valid immutable photo must still fail metadata inspection on retries.
    {
      const details = JSON.parse(await readFile('workers/api/test/fixtures/heif-hdr.json', 'utf8'));
      const bytes = await readFile('workers/api/test/fixtures/heif-hdr.heic');
      const issued = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer)).body;
      const capture: CaptureManifest = {
        ...manifest,
        policyVersion: 'capture-v3',
        sessionId: issued.sessionId,
        nonce: issued.nonce,
        clientCaptureId: randomUUID(),
        assets: [
          {
            ...details,
            hasGainMap: false,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          manifest.assets[1],
        ],
      };
      const path = `/v1/installations/${installationId}/captures/${capture.sessionId}`;
      equal(
        (
          await call(
            path + '/commit',
            'POST',
            { manifest: capture, proof: proof(capture, videoCounter++) },
            bearer,
          )
        ).status,
        200,
        'v3 forged gain map declaration commits before binary inspection',
      );
      for (const a of capture.assets)
        await mf.dispatchFetch('http://test' + path + '/assets/' + a.id, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + bearer,
            'Content-Type': a.mime,
            'Content-Length': String(a.bytes),
          },
          body: a.id === 'original' ? bytes : jpeg,
        });
      equal(
        (await call(path + '/complete', 'POST', {}, bearer)).status,
        422,
        'gain map mismatch cannot receive receipt',
      );
      equal(
        (await call(path + '/complete', 'POST', {}, bearer)).status,
        422,
        'immutable original cannot bypass validation on retry',
      );
      const pending = (
        await call(
          '/v1/posts',
          'POST',
          {
            installationId,
            captureId: capture.sessionId,
            caption: 'invalid',
            visibility: 'private',
          },
          bearer,
        )
      ).body.post;
      equal(pending.state, 'PROCESSING', 'invalid original remains processing');
      equal(
        (await call(`/v1/posts/${pending.post_id}/media-grants`, 'POST', {}, bearer)).status,
        409,
        'unverified immutable original cannot be viewed',
      );
      equal(
        (await call(`/v1/posts/${pending.post_id}/publish`, 'POST', {}, bearer)).body.post.state,
        'PROCESSING',
        'unverified original cannot be published',
      );
      await call(`/v1/posts/${pending.post_id}`, 'DELETE', undefined, bearer);
    }
    const mismatched = (await call('/v1/capture-sessions', 'POST', { installationId }, bearer))
      .body;
    const wrongBytes = await readFile('workers/api/test/fixtures/audio.mp4');
    const { hasAudio: unusedAudio, ...wrongDetails } = JSON.parse(
      await readFile('workers/api/test/fixtures/audio.json', 'utf8'),
    );
    const wrong: CaptureManifest = {
      ...manifest,
      kind: 'video',
      sessionId: mismatched.sessionId,
      nonce: mismatched.nonce,
      clientCaptureId: randomUUID(),
      assets: [
        { ...wrongDetails, sha256: createHash('sha256').update(wrongBytes).digest('hex') },
        { ...manifest.assets[1], id: 'poster', role: 'poster' },
      ],
    };
    const wrongPath = `/v1/installations/${installationId}/captures/${mismatched.sessionId}`;
    equal(
      (
        await call(
          wrongPath + '/commit',
          'POST',
          { manifest: wrong, proof: proof(wrong, videoCounter++) },
          bearer,
        )
      ).status,
      200,
      'structurally valid manifest is committed before media inspection',
    );
    for (const a of wrong.assets)
      await mf.dispatchFetch('http://test' + wrongPath + '/assets/' + a.id, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + bearer,
          'Content-Type': a.mime,
          'Content-Length': String(a.bytes),
        },
        body: a.id === 'original' ? wrongBytes : jpeg,
      });
    equal(
      (await call(wrongPath + '/complete', 'POST', {}, bearer)).status,
      422,
      'undeclared audio track cannot receive a verified receipt',
    );
    await call(wrongPath, 'DELETE', undefined, bearer);
    const rotated = await call('/v1/auth/refresh', 'POST', {
      refreshToken: sessionId + '.' + refresh,
    });
    equal(rotated.status, 200, 'refresh rotation');
    equal(
      (await call('/v1/auth/refresh', 'POST', { refreshToken: sessionId + '.' + refresh })).status,
      401,
      'old refresh rejected',
    );
    equal(
      (await call('/v1/me', 'GET', undefined, rotated.body.accessToken)).status,
      401,
      'reuse revokes token family',
    );
    // Real workerd + D1 retry/lease flow, with recorded genuine third-party signatures.
    // Network is isolated above: no integration fixture can publish or contact a provider.
    const anchorID = randomUUID();
    equal(
      (
        await call('/__fixture/network', 'POST', {
          certificate: anchorFixture.certificate,
          nonce: anchorFixture.anchors.nonce,
        })
      ).body,
      { status: 503 },
      'workerd outbound HTTP supports bounded non-redirecting requests',
    );
    tsaRequests = 0;
    const owner = (await db
      .prepare('SELECT user_id FROM profiles LIMIT 1')
      .first<{ user_id: string }>())!.user_id;
    await db
      .prepare(
        'INSERT INTO capture_proofs(proof_id,capture_id,installation_id,owner_id,certificate,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        anchorID,
        randomUUID(),
        installationId,
        owner,
        anchorFixture.certificate,
        new Date().toISOString(),
      )
      .run();
    await db
      .prepare('INSERT INTO proof_anchors(proof_id,certificate_digest,nonce) VALUES(?,?,?)')
      .bind(anchorID, hash(anchorFixture.certificate), anchorFixture.anchors.nonce)
      .run();
    const attempt = () =>
      call('/__fixture/anchor', 'POST', { id: anchorID, certificate: anchorFixture.certificate });
    await Promise.all([attempt(), attempt(), attempt()]);
    let ar = await db
      .prepare('SELECT * FROM proof_anchors WHERE proof_id=?')
      .bind(anchorID)
      .first<any>();
    equal(
      tsaRequests,
      1,
      'lease permits one external attempt across concurrent calls: ' +
        JSON.stringify({ attempts: ar.attempts, stage: ar.last_error }),
    );
    equal(ar.anchors, null, 'TSA outage cannot create successful evidence');
    equal(ar.attempts, 1, 'attempt counted durably');
    equal(ar.next_attempt > Date.now(), true, 'backoff persists');
    await attempt();
    equal(tsaRequests, 1, 'manual retry respects provider backoff');
    externalOutage = false;
    await db
      .prepare('UPDATE proof_anchors SET next_attempt=0 WHERE proof_id=?')
      .bind(anchorID)
      .run();
    await attempt();
    ar = await db
      .prepare('SELECT * FROM proof_anchors WHERE proof_id=?')
      .bind(anchorID)
      .first<any>();
    equal(
      ar.timestamp_response,
      anchorFixture.anchors.timestamp,
      'verified RFC3161 response durably saved before log upload',
    );
    equal(ar.anchors, null, 'log outage cannot create successful evidence');
    equal(logRequests.length, 1, 'log registration attempted once');
    logOutage = false;
    await db
      .prepare('UPDATE proof_anchors SET next_attempt=0 WHERE proof_id=?')
      .bind(anchorID)
      .run();
    await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
    equal(
      await db
        .prepare("SELECT id FROM early_access_registrations WHERE email='expired@example.invalid'")
        .first(),
      null,
      'cron removes expired registration',
    );
    equal(
      !!(await db
        .prepare("SELECT id FROM early_access_registrations WHERE email='active@example.invalid'")
        .first()),
      true,
      'cron retains active consent',
    );
    const completedAnchor = await attempt();
    equal(
      completedAnchor.body.state,
      'anchored',
      'workerd verifies TSA and log evidence before completion',
    );
    equal(tsaRequests, 2, 'retry reuses timestamp rather than changing external time');
    equal(logRequests[0], logRequests[1], 'retry preserves exact signature and public log request');
    ar = await db
      .prepare('SELECT * FROM proof_anchors WHERE proof_id=?')
      .bind(anchorID)
      .first<any>();
    await verifyAnchors({ ...anchorFixture, anchors: JSON.parse(ar.anchors) });
    checks++;
    await attempt();
    equal(logRequests.length, 2, 'completed registration does not republish');
    equal(
      JSON.stringify(logRequests).includes(anchorFixture.certificate),
      false,
      'external log receives no certificate contents',
    );
    equal(
      (
        await call('/__fixture/anchor', 'POST', {
          id: anchorID,
          certificate: anchorFixture.certificate + 'changed',
        })
      ).body.state,
      'mismatch',
      'database certificate replacement detected against stored commitment',
    );
    console.log(
      `Integration passed: ${checks} assertions (real workerd, SQLite DO, D1, R2, EC assertions and ES256 receipts).`,
    );
  } finally {
    await mf.dispose();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
