import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MP4Inspector } from '../src/mp4';
import { manifestSchema, type CaptureManifest } from '@justtaken/contracts';
function fixture(name = 'audio') {
  const bytes = readFileSync(`workers/api/test/fixtures/${name}.mp4`);
  const { hasAudio, ...details } = JSON.parse(
    readFileSync(`workers/api/test/fixtures/${name}.json`, 'utf8'),
  );
  const asset = {
    ...details,
    ...(hasAudio ? { audioCodec: 'aac-lc' } : {}),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } as CaptureManifest['assets'][number];
  return { bytes, asset };
}
function inspect(bytes: Uint8Array, asset: CaptureManifest['assets'][number], step = 257) {
  const i = new MP4Inspector(asset);
  for (let p = 0; p < bytes.length; p += step) i.push(bytes.subarray(p, p + step));
  i.finish();
}
for (const name of [
  'audio',
  'silent',
  'limit',
  'android-faststart',
  'original-silent',
  'original-audio',
  'original-hevc',
  'original-hdr',
  'original-limit',
])
  test(`AVFoundation ${name} output passes streaming MP4 inspection`, () => {
    const f = fixture(name);
    inspect(f.bytes, f.asset);
  });
test('MP4 streaming accepts split box headers', () => {
  const f = fixture();
  inspect(f.bytes, f.asset, 1);
});
test('MP4 rejects missing or unexpected audio', () => {
  const f = fixture();
  const { audioCodec, ...silent } = f.asset;
  assert.throws(() => inspect(f.bytes, silent));
  const s = fixture('silent');
  assert.throws(() => inspect(s.bytes, { ...s.asset, audioCodec: 'aac-lc' }));
});
test('MP4 checks duration, dimensions and frame rate against manifest', () => {
  const f = fixture();
  for (const changed of [
    { durationMs: 3000 },
    { width: 128 },
    { fpsNumerator: 61 },
    { fpsNumerator: 15 },
  ])
    assert.throws(() => inspect(f.bytes, { ...f.asset, ...changed }));
});
test('MP4 rejects truncation, oversized boxes and trailing data', () => {
  const f = fixture();
  assert.throws(() => inspect(f.bytes.subarray(0, -1), f.asset));
  const b = Buffer.from(f.bytes);
  b.writeUInt32BE(0xffffffff, 0);
  assert.throws(() => inspect(b, f.asset));
  assert.throws(() => inspect(Buffer.concat([f.bytes, Buffer.from([0])]), f.asset));
});
test('MP4 rejects HEVC sample descriptions and container location metadata', () => {
  const f = fixture();
  for (const [from, to] of [
    ['avc1', 'hvc1'],
    ['moov', 'uuid'],
  ]) {
    const b = Buffer.from(f.bytes);
    const at = b.indexOf(from, from === 'avc1' ? 100 : 0);
    assert.ok(at >= 0);
    b.write(to, at, 'ascii');
    assert.throws(() => inspect(b, f.asset));
  }
});
test('MP4 rejects sample offsets outside media payload', () => {
  const f = fixture(),
    b = Buffer.from(f.bytes);
  const at = b.indexOf('stco');
  assert.ok(at > 0);
  b.writeUInt32BE(0, at + 12);
  assert.throws(() => inspect(b, f.asset));
});
test('Native normalizer removes source location metadata and rotates into portrait pixels', () => {
  const f = fixture();
  assert.equal(f.bytes.includes(Buffer.from('+35.0000+139.0000/')), false);
  assert.equal(f.bytes.includes(Buffer.from('©xyz')), false);
  assert.equal(f.asset.width, 64);
  assert.equal(f.asset.height, 96);
});
test('Video policy accepts 60 seconds / 12 MiB and rejects values above the limits', () => {
  const f = fixture();
  const base = {
    version: 1,
    policyVersion: 'capture-v1',
    sessionId: 's',
    installationId: 'i',
    accountBindingId: 'a',
    clientCaptureId: 'c',
    nonce: 'n'.repeat(43),
    clientCapturedAt: '2026-10-25T00:00:00Z',
    kind: 'video',
    assets: [
      { ...f.asset, durationMs: 60000, bytes: 12582912 },
      {
        id: 'poster',
        role: 'poster',
        mime: 'image/jpeg',
        bytes: 100,
        width: 64,
        height: 96,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  assert.ok(manifestSchema.safeParse(base).success);
  for (const change of [{ durationMs: 60001 }, { bytes: 12582913 }])
    assert.equal(
      manifestSchema.safeParse({
        ...base,
        assets: [{ ...base.assets[0], ...change }, base.assets[1]],
      }).success,
      false,
    );
});

test('passthrough retains rotation, audio, HEVC bit depth and HDR, with no private location', () => {
  for (const name of ['original-silent', 'original-audio', 'original-hevc', 'original-hdr']) {
    const f = fixture(name);
    assert.equal(f.asset.rotationDegrees, 90);
    assert.equal(f.bytes.includes(Buffer.from('+35.0000+139.0000/')), false);
    assert.throws(() => inspect(f.bytes, { ...f.asset, rotationDegrees: 0 }));
    if (name === 'original-hevc' || name === 'original-hdr') {
      assert.equal(f.asset.width, 3840);
      assert.equal(f.asset.height, 2160);
      assert.throws(() => inspect(f.bytes, { ...f.asset, videoCodec: 'h264' }));
    }
    if (name === 'original-hdr') {
      assert.equal(f.asset.videoBitDepth, 10);
      assert.equal(f.asset.colorTransfer, 'hlg');
      assert.throws(() => inspect(f.bytes, { ...f.asset, videoBitDepth: 8 }));
      assert.throws(() => inspect(f.bytes, { ...f.asset, colorTransfer: 'sdr' }));
    }
  }
});
