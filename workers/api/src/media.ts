import { createHash } from 'node:crypto';
import { mediaExtension, type CaptureManifest } from '@justtaken/contracts';
import { fail } from './http';
import { JPEGInspector } from './jpeg';
import { MP4Inspector } from './mp4';
import { inspectOriginalPhoto } from './photo-original';
type Asset = CaptureManifest['assets'][number];
export const stagingKey = (installationId: string, sessionId: string, id: string) =>
  `${installationId}/${sessionId}/${id}`;
export const originalKey = (installationId: string, sessionId: string, a: Asset) =>
  `${installationId}/${sessionId}/${a.id}/${a.sha256}.${mediaExtension(a.mime)}`;
function matches(object: R2Object, a: Asset, staging = false) {
  return (
    object.size === a.bytes &&
    ((object.checksums.sha256 &&
      Buffer.from(object.checksums.sha256).toString('hex') === a.sha256) ||
      (staging && object.customMetadata?.sha256 === a.sha256))
  );
}
export async function stage(bucket: R2Bucket, key: string, asset: Asset, request: Request) {
  if (request.headers.get('content-type') !== asset.mime)
    fail(415, 'MEDIA_TYPE_MISMATCH', '撮影記録とファイル形式が一致しません。');
  if (request.headers.get('content-length') !== String(asset.bytes))
    fail(400, 'SIZE_MISMATCH', '撮影記録とファイルサイズが一致しません。');
  const existing = await bucket.head(key);
  if (existing) {
    await request.body?.cancel();
    if (!matches(existing, asset))
      fail(409, 'ASSET_CONFLICT', '保存済みのメディアと一致しません。');
    return;
  }
  if (!request.body) fail(400, 'EMPTY_ASSET', 'メディアがありません。');
  const fixed = new FixedLengthStream(asset.bytes);
  const writing = bucket.put(key, fixed.readable, {
    sha256: asset.sha256,
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: asset.mime },
  });
  try {
    const [result] = await Promise.all([writing, request.body!.pipeTo(fixed.writable)]);
    if (!result) {
      const winner = await bucket.head(key);
      if (!winner || !matches(winner, asset))
        fail(409, 'ASSET_CONFLICT', 'メディアが一致しません。');
    }
  } catch {
    fail(422, 'ASSET_MISMATCH', '撮影記録とメディアが一致しません。再送してください。');
  }
}
export async function freezeAsset(
  staging: R2Bucket,
  originals: R2Bucket,
  from: string,
  to: string,
  asset: Asset,
) {
  async function validateOriginal() {
    if (asset.preservation !== 'camera-original') return;
    try {
      await inspectOriginalPhoto(originals, to, asset);
    } catch {
      fail(422, 'MEDIA_REJECTED', '原本の形式・HDR情報または撮影記録を確認できませんでした。');
    }
  }
  const existing = await originals.head(to);
  if (existing) {
    if (!matches(existing, asset))
      fail(409, 'IMMUTABLE_CONFLICT', 'メディアを確認できませんでした。');
    await validateOriginal();
    return;
  }
  const source = await staging.get(from);
  if (!source) fail(409, 'UPLOAD_INCOMPLETE', 'メディアのアップロードが完了していません。');
  if (!matches(source, asset, true)) fail(422, 'ASSET_MISMATCH', 'メディアの情報が一致しません。');
  const inspector =
      asset.preservation === 'camera-original'
        ? null
        : asset.mime === 'video/mp4'
          ? new MP4Inspector(asset)
          : new JPEGInspector(asset.width, asset.height, asset.orientation ?? 1),
    hash = createHash('sha256');
  let size = 0;
  const validator = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length;
      if (size > asset.bytes) throw new Error('Size limit');
      hash.update(chunk);
      inspector?.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      inspector?.finish();
      if (size !== asset.bytes || hash.digest('hex') !== asset.sha256)
        throw new Error('Hash mismatch');
    },
  });
  const fixed = new FixedLengthStream(asset.bytes);
  // Hash and persist the same source stream; the final object is never overwritten.
  // v3 container inspection reads this checksum-verified immutable object afterwards.
  const writing = originals.put(to, fixed.readable, {
    sha256: asset.sha256,
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: asset.mime },
  });
  try {
    const [result] = await Promise.all([
      writing,
      source.body.pipeThrough(validator).pipeTo(fixed.writable),
    ]);
    if (!result) {
      const winner = await originals.head(to);
      if (!winner || !matches(winner, asset)) throw new Error('Conflicting object');
    }
  } catch {
    fail(422, 'MEDIA_REJECTED', 'メディアの形式または撮影記録を確認できませんでした。');
  }
  // Validate only the immutable, checksum-verified object. Repeated completion validates again.
  await validateOriginal();
}

export async function uploadPart(
  bucket: R2Bucket,
  key: string,
  id: string,
  number: number,
  bytes: number,
  digest: string,
  body: ReadableStream<Uint8Array>,
) {
  const hash = createHash('sha256'),
    fixed = new FixedLengthStream(bytes);
  const validator = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      hash.update(chunk);
      c.enqueue(chunk);
    },
    flush() {
      if (hash.digest('hex') !== digest) throw new Error('Part hash mismatch');
    },
  });
  try {
    const [part] = await Promise.all([
      bucket.resumeMultipartUpload(key, id).uploadPart(number, fixed.readable),
      body.pipeThrough(validator).pipeTo(fixed.writable),
    ]);
    return part;
  } catch {
    return fail(
      422,
      'PART_REJECTED',
      '分割データを確認できませんでした。同じ下書きから再送してください。',
    );
  }
}
