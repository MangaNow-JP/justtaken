import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inspectHEIF,
  memoryPhotoReader,
  CameraJPEGInspector,
  inspectDNG,
} from '../src/photo-original';
import type { CaptureManifest } from '@justtaken/contracts';
type Asset = CaptureManifest['assets'][number];
const fixture = (name: string) => ({
  asset: JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Asset,
  bytes: new Uint8Array(
    readFileSync(
      new URL(
        `./fixtures/${name}.${name.startsWith('heif') ? 'heic' : name.includes('dng') ? 'dng' : 'jpg'}`,
        import.meta.url,
      ),
    ),
  ),
});
async function inspect(bytes: Uint8Array, asset: Asset) {
  if (asset.mime === 'image/heic') return inspectHEIF(memoryPhotoReader(bytes), asset);
  if (asset.mime === 'image/x-adobe-dng') return inspectDNG(memoryPhotoReader(bytes), asset);
  const p = new CameraJPEGInspector();
  for (let i = 0; i < bytes.length; i += 137) p.push(bytes.subarray(i, i + 137));
  return p.finish(asset);
}
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
  test(`${name}: complete camera container matches orientation and HDR declaration`, async () => {
    const { bytes, asset } = fixture(name);
    await inspect(bytes, asset);
  });
  test(`${name}: rejects incorrect dimensions, orientation, gain map, truncation and MIME`, async () => {
    const { bytes, asset } = fixture(name);
    await assert.rejects(inspect(bytes, { ...asset, width: asset.width + 1 }));
    await assert.rejects(inspect(bytes, { ...asset, orientation: 1 }));
    await assert.rejects(inspect(bytes, { ...asset, hasGainMap: !asset.hasGainMap }));
    await assert.rejects(inspect(bytes.subarray(0, bytes.length - 7), asset));
    await assert.rejects(
      inspect(bytes, { ...asset, mime: asset.mime === 'image/heic' ? 'image/jpeg' : 'image/heic' }),
    );
  });
}

test('RAW rejects GPS, cyclic directories, malformed version and pixel offsets outside file', async () => {
  const { asset, bytes } = fixture('bayer-dng');
  const findTag = (b: Uint8Array, tag: number) => {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
      offset = v.getUint32(4, true),
      count = v.getUint16(offset, true);
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12;
      if (v.getUint16(p, true) === tag) return p;
    }
    throw Error('Missing fixture tag');
  };
  const gps = bytes.slice();
  new DataView(gps.buffer).setUint16(findTag(gps, 50708), 34853, true);
  await assert.rejects(inspect(gps, asset), /GPS/);
  const cycle = bytes.slice(),
    view = new DataView(cycle.buffer);
  view.setUint32(10 + view.getUint16(8, true) * 12, 8, true);
  await assert.rejects(inspect(cycle, asset), /Cyclic/);
  const outside = bytes.slice();
  new DataView(outside.buffer).setUint32(findTag(outside, 273) + 8, outside.length + 1, true);
  await assert.rejects(inspect(outside, asset));
  const version = bytes.slice();
  version[findTag(version, 50706) + 8] = 9;
  await assert.rejects(inspect(version, asset));
});
test('HEIF rejects external data references, GPS and forged auxiliary relation', async () => {
  const { asset, bytes } = fixture('heif-sdr');
  const external = bytes.slice(),
    iloc = Buffer.from(external).indexOf('iloc') + 4;
  new DataView(external.buffer).setUint16(iloc + 10, 1);
  await assert.rejects(inspect(external, asset));
  const gps = bytes.slice(),
    tiff = Buffer.from(gps).indexOf(Buffer.from('Exif\0\0MM')) + 6;
  assert.ok(tiff > 6);
  new DataView(gps.buffer).setUint16(tiff + 10, 34853);
  await assert.rejects(inspect(gps, asset), /GPS/);
  const hdr = fixture('heif-hdr'),
    orphan = hdr.bytes.slice(),
    link = Buffer.from(orphan).indexOf('dimg') + 4;
  new DataView(orphan.buffer).setUint16(link + 4, 2);
  await assert.rejects(inspect(orphan, hdr.asset));
});
test('JPEG HDR rejects broken MPF offsets, missing gain image, missing MPF and GPS originals', async () => {
  const { asset, bytes } = fixture('jpeg-hdr');
  const corrupt = bytes.slice(),
    mpf = Buffer.from(corrupt).indexOf(Buffer.from('MPF\0')) + 4;
  assert.ok(mpf > 4);
  const view = new DataView(corrupt.buffer),
    entry = mpf + view.getUint32(mpf + 42);
  view.setUint32(entry + 24, 1);
  await assert.rejects(inspect(corrupt, asset));
  const missing = bytes.slice(0, view.getUint32(entry + 4));
  await assert.rejects(inspect(missing, asset));
  const noIndex = bytes.slice();
  noIndex[mpf - 4] = 0;
  await assert.rejects(inspect(noIndex, asset));
  const gps = new Uint8Array(
    readFileSync(new URL('./fixtures/original-photo-source.jpg', import.meta.url)),
  );
  await assert.rejects(
    inspect(gps, { ...asset, width: 4032, height: 3024, hasGainMap: false }),
    /GPS/,
  );
});
