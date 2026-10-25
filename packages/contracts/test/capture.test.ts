import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalManifest,
  manifestSchema,
  manifestDigest,
  canPublish,
  canViewPost,
  countGraphemes,
  type CaptureManifest,
} from '../src/index';
import {
  assertCommitBinding,
  assertUploadWindow,
  checkReplay,
  type CaptureSession,
} from '../src/session';
const photo: CaptureManifest = {
  version: 1,
  policyVersion: 'capture-v1',
  sessionId: 'cs_1',
  installationId: 'in_1',
  accountBindingId: 'ab_1',
  clientCaptureId: 'cc_1',
  nonce: 'a'.repeat(43),
  clientCapturedAt: '2026-10-25T08:00:03Z',
  kind: 'photo',
  assets: [
    {
      id: 'original',
      role: 'original',
      mime: 'image/jpeg',
      bytes: 349000,
      width: 2048,
      height: 1536,
      sha256: 'a'.repeat(64),
    },
    {
      id: 'thumbnail',
      role: 'thumbnail',
      mime: 'image/jpeg',
      bytes: 42100,
      width: 480,
      height: 360,
      sha256: 'b'.repeat(64),
    },
  ],
};
const copy = () => structuredClone(photo);
const session: CaptureSession = {
  id: 'cs_1',
  installationId: 'in_1',
  accountBindingId: 'ab_1',
  nonce: photo.nonce,
  state: 'ISSUED',
  commitExpiresAt: 300000,
};

test('canonical digest is independent of JSON key order', async () => {
  const reversed = Object.fromEntries(Object.entries(photo).reverse());
  assert.equal(canonicalManifest(reversed), canonicalManifest(photo));
  assert.equal(await manifestDigest(reversed), await manifestDigest(photo));
});
test('original and thumbnail changes both change the bound digest', async () => {
  const before = await manifestDigest(photo);
  for (const index of [0, 1]) {
    const changed = copy();
    changed.assets[index]!.sha256 = 'c'.repeat(64);
    assert.notEqual(await manifestDigest(changed), before);
  }
});
test('unknown fields, extra assets and role reordering are rejected', () => {
  assert.equal(
    manifestSchema.safeParse({ ...photo, arbitraryPath: '/tmp/fake.jpg' }).success,
    false,
  );
  assert.equal(
    manifestSchema.safeParse({ ...photo, assets: [...photo.assets, photo.assets[1]] }).success,
    false,
  );
  assert.equal(
    manifestSchema.safeParse({ ...photo, assets: [...photo.assets].reverse() }).success,
    false,
  );
});
for (const [field, value] of [
  ['bytes', 1_048_577],
  ['width', 2049],
  ['width', 1.5],
  ['height', 0],
  ['sha256', 'not-a-hash'],
] as const)
  test(`invalid original ${field}=${value} is rejected`, () => {
    const input = copy();
    Object.assign(input.assets[0]!, { [field]: value });
    assert.equal(manifestSchema.safeParse(input).success, false);
  });
test('oversized thumbnail and photo video fields are rejected', () => {
  const input = copy();
  input.assets[1]!.bytes = 65537;
  assert.equal(manifestSchema.safeParse(input).success, false);
  const fields = copy();
  fields.assets[0]!.durationMs = 1000;
  assert.equal(manifestSchema.safeParse(fields).success, false);
});
test('video limits cover portrait and landscape, codec, frame rate, duration', () => {
  const input = copy();
  input.kind = 'video';
  Object.assign(input.assets[0]!, {
    mime: 'video/mp4',
    bytes: 6000000,
    width: 720,
    height: 1280,
    durationMs: 30000,
    videoCodec: 'h264',
    audioCodec: 'aac-lc',
    fpsNumerator: 30000,
    fpsDenominator: 1001,
  });
  Object.assign(input.assets[1]!, { id: 'poster', role: 'poster' });
  assert.equal(manifestSchema.safeParse(input).success, true);
  input.assets[0]!.durationMs = 60001;
  assert.equal(manifestSchema.safeParse(input).success, false);
  input.assets[0]!.durationMs = 30000;
  input.assets[0]!.fpsNumerator = 60000;
  assert.equal(manifestSchema.safeParse(input).success, false);
});
test('session binding refuses cross-account, cross-installation and nonce reuse', () => {
  assert.doesNotThrow(() => assertCommitBinding(session, photo, 299999));
  for (const key of ['sessionId', 'installationId', 'accountBindingId', 'nonce'] as const)
    assert.throws(
      () => assertCommitBinding(session, { ...photo, [key]: 'other' }, 1000),
      /SESSION_BINDING_MISMATCH/,
    );
  assert.throws(
    () => assertCommitBinding({ ...session, state: 'COMMITTED' }, photo, 1000),
    /NONCE_ALREADY_CONSUMED/,
  );
});
test('expiry boundary rejects approval at or after deadline', () => {
  assert.throws(() => assertCommitBinding(session, photo, 300000), /SESSION_EXPIRED/);
  assert.throws(
    () =>
      assertUploadWindow({ ...session, state: 'UPLOADING', uploadExpiresAt: 86400000 }, 86400000),
    /UPLOAD_WINDOW_EXPIRED/,
  );
  assert.throws(
    () => assertUploadWindow({ ...session, state: 'CANCELLED', uploadExpiresAt: 86400000 }, 1000),
    /UPLOAD_NOT_ALLOWED/,
  );
});
test('matching retries return the original response; conflicting retries fail', () => {
  const response = { state: 'COMMITTED', uploadExpiresAt: 86400000 };
  assert.equal(checkReplay({ digest: 'fixed', response }, 'fixed'), response);
  assert.throws(() => checkReplay({ digest: 'fixed', response }, 'changed'), /MANIFEST_CONFLICT/);
});
test('verification alone never permits publishing', () => {
  const ready = {
    captureState: 'VERIFIED' as const,
    mediaReady: true,
    moderation: 'allowed' as const,
    accountActive: true,
    deleted: false,
  };
  assert.equal(canPublish(ready), true);
  for (const patch of [
    { captureState: 'COMMITTED' as const },
    { mediaReady: false },
    { moderation: 'pending' as const },
    { accountActive: false },
    { deleted: true },
  ])
    assert.equal(canPublish({ ...ready, ...patch }), false);
});
test('private account, blocked access, pending follows and deleted posts fail closed', () => {
  const base = {
    isOwner: false,
    accountPrivate: true,
    approvedFollower: false,
    blocked: false,
    postState: 'PUBLISHED',
    visibility: 'public' as const,
  };
  assert.equal(canViewPost(base), false);
  assert.equal(canViewPost({ ...base, approvedFollower: true }), true);
  assert.equal(canViewPost({ ...base, accountPrivate: false }), true);
  assert.equal(canViewPost({ ...base, approvedFollower: true, blocked: true }), false);
  assert.equal(canViewPost({ ...base, approvedFollower: true, visibility: 'private' }), false);
  assert.equal(canViewPost({ ...base, isOwner: true, postState: 'DELETED' }), false);
  assert.equal(canViewPost({ ...base, approvedFollower: true, postState: 'PROCESSING' }), false);
});
test('Japanese combining characters and emoji count as graphemes', () => {
  assert.equal(countGraphemes('か\u3099👨‍👩‍👧‍👦🇯🇵'), 3);
});

test('v2 keeps full resolution JPEGs and binds orientation while v1 limits remain', async () => {
  const value = copy();
  value.policyVersion = 'capture-v2';
  Object.assign(value.assets[0], {
    width: 12000,
    height: 9000,
    bytes: 64 * 1024 * 1024,
    orientation: 6,
  });
  assert.ok(manifestSchema.safeParse(value).success);
  assert.equal(manifestSchema.safeParse({ ...value, policyVersion: 'capture-v1' }).success, false);
  const digest = await manifestDigest(value);
  value.assets[0].orientation = 8;
  assert.notEqual(await manifestDigest(value), digest);
  for (const patch of [
    { bytes: 64 * 1024 * 1024 + 1 },
    { width: 16385 },
    { width: 16000, height: 16000 },
    { orientation: 0 },
    { orientation: undefined },
  ]) {
    assert.equal(
      manifestSchema.safeParse({
        ...value,
        assets: [{ ...value.assets[0], ...patch }, value.assets[1]],
      }).success,
      false,
    );
  }
});
test('v2 accepts 4K 60 fps HEVC HDR up to 60 seconds and 512 MiB, with format constraints', () => {
  const original = {
    id: 'original',
    role: 'original',
    mime: 'video/mp4',
    width: 3840,
    height: 2160,
    bytes: 536870912,
    durationMs: 60000,
    videoCodec: 'hevc',
    videoBitDepth: 10,
    colorTransfer: 'hlg',
    rotationDegrees: 90,
    fpsNumerator: 60000,
    fpsDenominator: 1000,
    sha256: 'a'.repeat(64),
  };
  const value = {
    ...photo,
    policyVersion: 'capture-v2',
    kind: 'video',
    assets: [original, { ...photo.assets[1], id: 'poster', role: 'poster' }],
  };
  assert.ok(manifestSchema.safeParse(value).success);
  for (const patch of [
    { durationMs: 60001 },
    { bytes: 536870913 },
    { width: 7680 },
    { fpsNumerator: 61000 },
    { videoBitDepth: 8 },
    { videoCodec: 'h264' },
    { rotationDegrees: 45 },
    { colorTransfer: undefined },
  ])
    assert.equal(
      manifestSchema.safeParse({ ...value, assets: [{ ...original, ...patch }, value.assets[1]] })
        .success,
      false,
    );
});

test('v3 preserves HEIF, RAW and HDR containers; legacy policies and preview constraints stay strict', async () => {
  for (const mime of ['image/jpeg', 'image/heic', 'image/x-adobe-dng'] as const) {
    const original = {
      ...photo.assets[0],
      mime,
      width: 8000,
      height: 6000,
      orientation: 6,
      bytes: mime === 'image/x-adobe-dng' ? 536870912 : 134217728,
      preservation: 'camera-original' as const,
      hasGainMap: false,
    };
    const value = { ...photo, policyVersion: 'capture-v3', assets: [original, photo.assets[1]] };
    assert.ok(manifestSchema.safeParse(value).success);
    const digest = await manifestDigest(value);
    assert.notEqual(
      await manifestDigest({
        ...value,
        assets: [{ ...original, hasGainMap: true }, photo.assets[1]],
      }),
      digest,
    );
    for (const patch of [
      { bytes: original.bytes + 1 },
      { preservation: undefined },
      { hasGainMap: undefined },
      { orientation: undefined },
      { durationMs: 1 },
    ])
      assert.equal(
        manifestSchema.safeParse({ ...value, assets: [{ ...original, ...patch }, photo.assets[1]] })
          .success,
        false,
      );
    for (const policyVersion of ['capture-v1', 'capture-v2'])
      assert.equal(manifestSchema.safeParse({ ...value, policyVersion }).success, false);
    assert.equal(
      manifestSchema.safeParse({ ...value, assets: [original, { ...photo.assets[1], mime }] })
        .success,
      mime === 'image/jpeg',
    );
    assert.equal(
      manifestSchema.safeParse({
        ...value,
        assets: [original, { ...photo.assets[1], hasGainMap: false }],
      }).success,
      false,
    );
  }
});

test('GPS samples use canonical integers and are part of the attested digest', async () => {
  const value = copy();
  value.policyVersion = 'capture-v2';
  value.assets[0].orientation = 1;
  const location = {
    status: 'recorded' as const,
    source: 'device-location' as const,
    latitudeE7: 350000000,
    longitudeE7: 1390000000,
    horizontalAccuracyMm: 8300,
    measuredAt: value.clientCapturedAt,
    accuracyAuthorization: 'precise' as const,
  };
  const withGPS = { ...value, location };
  assert.ok(manifestSchema.safeParse(withGPS).success);
  const digest = await manifestDigest(withGPS);
  assert.notEqual(await manifestDigest(value), digest);
  for (const patch of [
    { latitudeE7: -350000000 },
    { longitudeE7: 1390000001 },
    { horizontalAccuracyMm: 8301 },
    { accuracyAuthorization: 'approximate' },
    { measuredAt: '2026-10-25T08:00:02Z' },
  ]) {
    assert.notEqual(
      await manifestDigest({ ...withGPS, location: { ...location, ...patch } }),
      digest,
    );
  }
  for (const status of ['off', 'unavailable']) {
    assert.ok(manifestSchema.safeParse({ ...value, location: { status } }).success);
    assert.equal(
      manifestSchema.safeParse({ ...value, location: { status, latitudeE7: 0 } }).success,
      false,
    );
  }
  assert.equal(manifestSchema.safeParse({ ...photo, location }).success, false);
  assert.equal(
    canonicalManifest(withGPS),
    canonicalManifest({
      ...withGPS,
      location: Object.fromEntries(Object.entries(location).reverse()),
    }),
  );
});

test('GPS rejects stale, future, out-of-range, fractional and undeclared data', () => {
  const value = copy();
  value.policyVersion = 'capture-v2';
  value.assets[0].orientation = 1;
  const location = {
    status: 'recorded',
    source: 'device-location',
    latitudeE7: 0,
    longitudeE7: 0,
    horizontalAccuracyMm: 0,
    measuredAt: value.clientCapturedAt,
    accuracyAuthorization: 'approximate',
  };
  for (const patch of [
    { latitudeE7: 900000001 },
    { latitudeE7: -900000001 },
    { longitudeE7: 1800000001 },
    { longitudeE7: -1800000001 },
    { latitudeE7: 0.1 },
    { longitudeE7: NaN },
    { horizontalAccuracyMm: -1 },
    { horizontalAccuracyMm: 100000001 },
    { horizontalAccuracyMm: Infinity },
    { measuredAt: '2026-10-25T07:59:47Z' },
    { measuredAt: '2026-10-25T08:00:04Z' },
    { source: 'verified-gps' },
    { accuracyAuthorization: 'unknown' },
    { altitude: 0 },
    { address: 'private' },
  ])
    assert.equal(
      manifestSchema.safeParse({ ...value, location: { ...location, ...patch } }).success,
      false,
      JSON.stringify(patch),
    );
  assert.ok(
    manifestSchema.safeParse({
      ...value,
      location: { ...location, measuredAt: '2026-10-25T07:59:48Z' },
    }).success,
  );
});
