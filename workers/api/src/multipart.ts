import { capturePolicy, type CaptureManifest } from '@justtaken/contracts';
import { Records } from './storage';
import { fail } from './http';
type Asset = CaptureManifest['assets'][number];
type Upload = {
  key: string;
  uploadId: string;
  parts: Record<string, R2UploadedPart & { digest: string }>;
  complete: boolean;
};
// All identifiers and final part ETags are held server-side. Never accept client-supplied ETags.
export class MultipartUploads {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private records: Records,
    private bucket: R2Bucket,
    private live: (user: string, id: string, asset: string) => { key: string; asset: Asset },
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(fn);
    this.queue = next;
    return next;
  }
  private name(id: string, asset: string) {
    return `multipart:${id}:${asset}`;
  }
  begin(user: string, id: string, assetId: string) {
    return this.serial(async () => {
      const { key, asset } = this.live(user, id, assetId),
        name = this.name(id, assetId);
      let saved = this.records.get<Upload>(name);
      if (!saved) {
        const upload = await this.bucket.createMultipartUpload(key, {
          httpMetadata: { contentType: asset.mime },
          customMetadata: { sha256: asset.sha256 },
        });
        try {
          this.live(user, id, assetId);
        } catch (error) {
          await upload.abort();
          throw error;
        }
        saved = { key, uploadId: upload.uploadId, parts: {}, complete: false };
        this.records.put(name, saved);
      }
      return {
        partBytes: capturePolicy.uploadPartBytes,
        totalParts: Math.ceil(asset.bytes / capturePolicy.uploadPartBytes),
        uploadedParts: Object.keys(saved.parts).map(Number),
        complete: saved.complete,
      };
    });
  }
  part(user: string, id: string, assetId: string, number: number, digest: string) {
    const { asset } = this.live(user, id, assetId),
      saved = this.records.get<Upload>(this.name(id, assetId));
    if (!saved) fail(409, 'UPLOAD_NOT_STARTED', 'アップロードを開始してください。');
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > Math.ceil(asset.bytes / capturePolicy.uploadPartBytes) ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      fail(400, 'INVALID_PART', '分割データの情報が正しくありません。');
    const previous = saved!.parts[number];
    if (previous && previous.digest !== digest)
      fail(409, 'PART_CONFLICT', '送信済みのデータと一致しません。');
    return {
      key: saved!.key,
      uploadId: saved!.uploadId,
      bytes: Math.min(
        capturePolicy.uploadPartBytes,
        asset.bytes - (number - 1) * capturePolicy.uploadPartBytes,
      ),
      uploaded: !!previous,
      mime: asset.mime,
    };
  }
  recordPart(
    user: string,
    id: string,
    assetId: string,
    number: number,
    digest: string,
    part: R2UploadedPart,
  ) {
    this.part(user, id, assetId, number, digest);
    const name = this.name(id, assetId),
      saved = this.records.get<Upload>(name)!;
    if (saved.complete) return;
    saved.parts[number] = { partNumber: number, etag: part.etag, digest };
    this.records.put(name, saved);
  }
  finish(user: string, id: string, assetId: string) {
    return this.serial(async () => {
      const { asset, key } = this.live(user, id, assetId),
        name = this.name(id, assetId),
        saved = this.records.get<Upload>(name);
      if (!saved) fail(409, 'UPLOAD_NOT_STARTED', 'アップロードを開始してください。');
      if (saved!.complete) return { uploaded: true };
      const expected = Math.ceil(asset.bytes / capturePolicy.uploadPartBytes);
      const parts = Array.from({ length: expected }, (_, i) => saved!.parts[i + 1]);
      if (parts.some((p) => !p))
        fail(409, 'UPLOAD_INCOMPLETE', '未送信のデータがあります。再送してください。');
      // Recover a crash after R2 complete but before the durable record was saved.
      let object = await this.bucket.head(key);
      if (!object)
        object = await this.bucket
          .resumeMultipartUpload(key, saved!.uploadId)
          .complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
      if (object.size !== asset.bytes || object.customMetadata?.sha256 !== asset.sha256)
        fail(422, 'ASSET_MISMATCH', 'ファイルの情報が一致しません。');
      this.live(user, id, assetId);
      this.records.put(name, { ...saved, complete: true });
      // The whole-file hash and format are checked separately by capture.complete, before VERIFIED.
      return { uploaded: true };
    });
  }
  async abort(id: string) {
    for (const row of this.records.all<Upload>(`multipart:${id}:`)) {
      if (!row.value.complete)
        await this.bucket.resumeMultipartUpload(row.value.key, row.value.uploadId).abort();
      this.records.delete(row.key);
    }
  }
}
