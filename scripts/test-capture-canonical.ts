// Compare the actual Swift signer encoder with the server's manifest encoder.
// No device, signing key or production data is involved.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { canonicalManifest } from '../packages/contracts/src/index';
const dir = mkdtempSync(join(tmpdir(), 'justtaken-canonical-'));
try {
  const main = `import Foundation
let data = FileHandle.standardInput.readDataToEndOfFile()
let inputs = try JSONSerialization.jsonObject(with: data) as! [Any]
for input in inputs { print(String(data: try CaptureCanonicalJSON.encode(input), encoding: .utf8)!) }
`;
  writeFileSync(join(dir, 'main.swift'), main);
  execFileSync('swiftc', [
    '-module-cache-path',
    join(dir, 'cache'),
    'native/capture/ios/CaptureCanonicalJSON.swift',
    join(dir, 'main.swift'),
    '-o',
    join(dir, 'check'),
  ]);
  const base = {
    version: 1,
    policyVersion: 'capture-v3',
    sessionId: 'session',
    installationId: 'installation',
    accountBindingId: 'binding',
    clientCaptureId: 'CAPTURE-ID',
    clientCapturedAt: '2026-10-30T14:49:32Z',
    nonce: 'a'.repeat(43),
    kind: 'photo',
    location: { status: 'off' },
    assets: [
      {
        id: 'original',
        role: 'original',
        mime: 'image/jpeg',
        bytes: 14_155_776,
        width: 8064,
        height: 6048,
        sha256: 'a'.repeat(64),
        preservation: 'camera-original',
        orientation: 1,
        hasGainMap: true,
      },
      {
        id: 'thumbnail',
        role: 'thumbnail',
        mime: 'image/jpeg',
        bytes: 30000,
        width: 480,
        height: 360,
        sha256: 'b'.repeat(64),
        orientation: 1,
      },
    ],
  };
  const fixtures: any[] = [base];
  for (const mime of ['image/heic', 'image/x-adobe-dng']) {
    const f = structuredClone(base);
    f.assets[0].mime = mime;
    f.assets[0].hasGainMap = mime !== 'image/x-adobe-dng';
    fixtures.push(f);
  }
  const gps = structuredClone(base) as any;
  gps.location = {
    status: 'recorded',
    latitudeE7: -356812360,
    longitudeE7: 1397671250,
    horizontalAccuracyMm: 12400,
    measuredAt: '2026-10-30T14:49:31Z',
    source: 'device-location',
    accuracyAuthorization: 'precise',
  };
  fixtures.push(gps);
  const video = structuredClone(base) as any;
  video.kind = 'video';
  video.assets[0] = {
    id: 'original',
    role: 'original',
    mime: 'video/mp4',
    bytes: 100_000_000,
    width: 3840,
    height: 2160,
    sha256: 'c'.repeat(64),
    durationMs: 60000,
    videoCodec: 'hevc',
    rotationDegrees: 90,
    videoBitDepth: 10,
    colorTransfer: 'hlg',
    audioCodec: 'aac-lc',
    fpsNumerator: 30,
    fpsDenominator: 1,
  };
  video.assets[1] = { ...video.assets[1], id: 'poster', role: 'poster', height: 270 };
  fixtures.push(video);
  // Additional primitive vector covers safe integer boundaries, escaped strings and
  // case-sensitive ordering independently of the manifest schema.
  const vectors = [
    ...fixtures,
    {
      z: false,
      Z: true,
      key10: -9007199254740991,
      key2: 9007199254740991,
      clientCapturedAt: 'time',
      clientCaptureId: 'id',
      escaped: 'a/"b\\c\n',
      zero: 0,
    },
  ];
  const actual = execFileSync(join(dir, 'check'), {
    input: JSON.stringify(vectors),
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  fixtures.forEach((f, i) => assert.equal(actual[i], canonicalManifest(f)));
  const primitive = vectors.at(-1)!;
  assert.equal(
    actual.at(-1),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(primitive).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    ),
  );
  assert.ok(actual[0].indexOf('clientCaptureId') < actual[0].indexOf('clientCapturedAt'));
  console.log(
    `Swift/server canonicalization: ${vectors.length} vectors passed (JPEG HDR, HEIF, RAW, GPS, 60s HDR video, ordering/booleans/integers).`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
