import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUniqueJSON, b64 } from '../src/http';
import { assertPlayVerdict } from '../src/proof';
import { parseRange } from '../src/posts';
import { JPEGInspector } from '../src/jpeg';
import { assertIdentityClaims } from '../src/identity';
import { readFileSync } from 'node:fs';
test('the actual iOS ImageIO normalization produces a clean JPEG accepted across arbitrary chunks', () => {
  const bytes = readFileSync('workers/api/test/fixtures/normalized.jpg');
  const inspector = new JPEGInspector(8, 8);
  for (let offset = 0; offset < bytes.length; offset += 7)
    inspector.push(bytes.subarray(offset, offset + 7));
  inspector.finish();
});
test('JSON rejects duplicate escaped names, trailing data, and deep structures', () => {
  assert.throws(() => parseUniqueJSON('{"nonce":"first","no\\u006ece":"second"}'));
  assert.throws(() => parseUniqueJSON('{"x":{"a":1,"a":2}}'));
  assert.throws(() => parseUniqueJSON('{}{}'));
  assert.throws(() => parseUniqueJSON('['.repeat(34) + '0' + ']'.repeat(34)));
  assert.deepEqual(parseUniqueJSON('{"text":"quote\\\"{}","a":[1,null]}'), {
    text: 'quote"{}',
    a: [1, null],
  });
});
test('identity requires a nonce, subject, issued-at and expiration', () => {
  const p = {
    sub: 'provider-subject',
    nonce: 'n',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  assert.equal(assertIdentityClaims(p, 'n'), 'provider-subject');
  assert.throws(() => assertIdentityClaims(p, 'different'));
  assert.throws(() => assertIdentityClaims({ ...p, sub: undefined }, 'n'));
});
test('Play Integrity binds all verdicts to this package, digest, certificate and freshness', () => {
  const digest = 'a'.repeat(64),
    env = {
      ANDROID_PACKAGE: 'app.justtaken.test',
      ANDROID_CERTIFICATES: 'cert1',
      ANDROID_MIN_VERSION: '3',
    };
  const payload = {
    requestDetails: {
      requestPackageName: env.ANDROID_PACKAGE,
      requestHash: b64(Buffer.from(digest, 'hex')),
      timestampMillis: '1000000',
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: env.ANDROID_PACKAGE,
      certificateSha256Digest: ['cert1'],
      versionCode: '3',
    },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
  };
  assert.doesNotThrow(() => assertPlayVerdict(payload, digest, env, 1000000));
  for (const patch of [
    { requestDetails: { ...payload.requestDetails, requestHash: 'tampered' } },
    { requestDetails: { ...payload.requestDetails, timestampMillis: '870000' } },
    { appIntegrity: { ...payload.appIntegrity, certificateSha256Digest: ['other'] } },
    { appIntegrity: { ...payload.appIntegrity, versionCode: '2' } },
    { deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } },
    { accountDetails: { appLicensingVerdict: 'UNLICENSED' } },
  ])
    assert.throws(() => assertPlayVerdict({ ...payload, ...patch }, digest, env, 1000000));
});
test('single ranges handle suffixes and reject unsatisfiable and multipart ranges', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), { offset: 2, length: 4 });
  assert.deepEqual(parseRange('bytes=-3', 10), { offset: 7, length: 3 });
  assert.deepEqual(parseRange('bytes=3-', 10), { offset: 3, length: 7 });
  for (const header of [
    'bytes=10-',
    'bytes=5-2',
    'bytes=0-2,5-6',
    'bytes=-0',
    'bytes=-',
    'bytes=9007199254740993-',
  ])
    assert.throws(() => parseRange(header, 10));
});
test('JPEG inspection rejects forged dimensions, metadata, truncation and trailing bytes across chunks', () => {
  // Minimal structural baseline JPEG: frame, scan, entropy and EOI. Pixel moderation is a separate gate.
  const jpeg = Uint8Array.from([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1,
    255, 0, 2, 255, 217,
  ]);
  const valid = new JPEGInspector(1, 1);
  for (const byte of jpeg) valid.push(Uint8Array.of(byte));
  valid.finish();
  assert.throws(() => {
    const v = new JPEGInspector(2, 1);
    v.push(jpeg);
    v.finish();
  });
  assert.throws(() => {
    const v = new JPEGInspector(1, 1);
    v.push(jpeg.slice(0, -2));
    v.finish();
  });
  assert.throws(() => {
    const v = new JPEGInspector(1, 1);
    v.push(jpeg);
    v.push(Uint8Array.of(0));
  });
  assert.throws(() => new JPEGInspector(1, 1).push(Uint8Array.from([255, 216, 255, 225, 0, 2])));
});
test('HTTP JSON rejects primitive roots and oversized UTF-8 bodies', async () => {
  const { bodyJSON } = await import('../src/http');
  for (const text of ['null', '[]', '"hello"'])
    await assert.rejects(
      () =>
        bodyJSON(
          new Request('http://test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: text,
          }),
        ),
      { status: 400 },
    );
  await assert.rejects(
    () =>
      bodyJSON(
        new Request('http://test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"value":"' + 'あ'.repeat(100) + '"}',
        }),
        128,
      ),
    { status: 413 },
  );
});

test('original JPEG accepts only canonical orientation EXIF, preserves full resolution and ICC', () => {
  const bytes = readFileSync('workers/api/test/fixtures/original-photo.jpg');
  assert.ok(bytes.includes(Buffer.from('ICC_PROFILE\0')));
  const valid = new JPEGInspector(4032, 3024, 6);
  for (let p = 0; p < bytes.length; p += 113) valid.push(bytes.subarray(p, p + 113));
  valid.finish();
  for (const changed of [new JPEGInspector(4032, 3024, 1), new JPEGInspector(2048, 1536, 6)])
    assert.throws(() => {
      changed.push(bytes);
      changed.finish();
    });
  const privateData = readFileSync('workers/api/test/fixtures/original-photo-source.jpg');
  assert.throws(() => {
    const i = new JPEGInspector(4032, 3024, 6);
    i.push(privateData);
    i.finish();
  });
  const altered = Buffer.from(bytes);
  altered[36] = 1;
  assert.throws(() => new JPEGInspector(4032, 3024, 6).push(altered));
});
