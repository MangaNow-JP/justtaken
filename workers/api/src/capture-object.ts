import { DurableObject } from 'cloudflare:workers';
import { CompactSign, importJWK } from 'jose';
import {
  manifestSchema,
  manifestDigest,
  capturePolicy,
  type CaptureManifest,
  type CaptureState,
} from '@justtaken/contracts';
import {
  assertCommitBinding,
  assertUploadWindow,
  type CaptureSession,
} from '@justtaken/contracts/session';
import { MultipartUploads } from './multipart';
import { Records } from './storage';
import { fail, requireValue, rpc, token } from './http';
import {
  verifyEnrollment,
  verifyCaptureProof,
  integrityConfigured,
  type Installation,
} from './proof';
import { freezeAsset, originalKey, stagingKey } from './media';
import type { Bindings } from './types';
export type StoredCapture = CaptureSession & {
  userId: string;
  manifest?: CaptureManifest;
  digest?: string;
  committedAt?: string;
  verifiedAt?: string;
  receipt?: string;
  receiptPayload?: string;
};
// Keep lifecycle/asset audit fields after retirement, but not precise position.
// This is not a new authenticatable manifest: retired captures cannot be verified.
function retiredCapture(capture: StoredCapture, state: 'CANCELLED' | 'EXPIRED'): StoredCapture {
  if (!capture.manifest) return { ...capture, state };
  const { location: _location, ...manifest } = capture.manifest;
  return { ...capture, state, manifest };
}
export class CaptureSecurity extends DurableObject<Bindings> {
  private records: Records;
  private uploads: MultipartUploads;
  // Serialize provider calls as well as the final transaction. Persisted state remains authoritative
  // after eviction; the queue prevents concurrent retries from decoding a Standard token twice.
  private commitQueue: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.records = new Records(ctx.storage);
    this.uploads = new MultipartUploads(this.records, env.STAGING, (user, id, asset) =>
      this.assetInfo(user, id, asset),
    );
  }
  private owner(userId: string): Installation {
    if (this.records.get('account-deleted'))
      fail(410, 'ACCOUNT_DELETED', 'このアカウントは削除されています。');
    const i = this.records.get<Installation>('installation');
    if (!i || i.userId !== userId) fail(404, 'INSTALLATION_NOT_FOUND', '端末を登録してください。');
    return i!;
  }
  private active(userId: string) {
    const i = this.owner(userId);
    if (!i.active) fail(403, 'INSTALLATION_NOT_READY', '端末認証を完了してください。');
    return i;
  }
  private capture(userId: string, id: string): StoredCapture {
    this.owner(userId);
    const s = this.records.get<StoredCapture>('capture:' + id);
    if (!s || s.userId !== userId) fail(404, 'CAPTURE_NOT_FOUND', '撮影記録が見つかりません。');
    return s!;
  }
  create(id: string, userId: string, platform: 'ios' | 'android') {
    return rpc(async () => {
      if (this.records.get('account-deleted'))
        fail(410, 'ACCOUNT_DELETED', 'このアカウントは削除されています。');
      requireValue(integrityConfigured(this.env, platform));
      if (this.records.get('installation'))
        fail(409, 'INSTALLATION_EXISTS', '端末を登録し直してください。');
      const accountBindingId = crypto.randomUUID();
      const i: Installation = {
        id,
        userId,
        platform,
        accountBindingId,
        challenge: `JUSTTAKEN_INSTALL_V1\0${id}\0${accountBindingId}\0${token()}`,
        expires: Date.now() + 300_000,
        active: false,
        counter: 0,
      };
      this.records.put('installation', i);
      await this.ctx.storage.setAlarm(i.expires);
      return { installationId: id, accountBindingId, challenge: i.challenge, expiresAt: i.expires };
    });
  }
  enroll(userId: string, proof: unknown) {
    return rpc(async () => {
      const i = this.owner(userId);
      if (i.active)
        return { installationId: i.id, accountBindingId: i.accountBindingId, ready: true };
      if (i.expires <= Date.now())
        fail(410, 'ENROLLMENT_EXPIRED', '端末登録の有効時間が過ぎました。');
      const result = await verifyEnrollment(i, proof, this.env);
      this.records.atomic(() => {
        const current = this.owner(userId);
        if (current.active) return;
        if (current.expires <= Date.now())
          fail(410, 'ENROLLMENT_EXPIRED', '端末登録の有効時間が過ぎました。');
        this.records.put('installation', { ...current, ...result, active: true, counter: 0 });
      });
      await this.ctx.storage.setAlarm(Date.now() + 86400_000);
      return { installationId: i.id, accountBindingId: i.accountBindingId, ready: true };
    });
  }
  issue(userId: string) {
    return rpc(async () => {
      const i = this.active(userId);
      requireValue(this.env.RECEIPT_PRIVATE_JWK && this.env.RECEIPT_KEY_ID);
      const pending = this.records
        .all<StoredCapture>('capture:')
        .filter(
          (r) =>
            ['ISSUED', 'COMMITTED', 'UPLOADING'].includes(r.value.state) &&
            Math.max(r.value.commitExpiresAt, r.value.uploadExpiresAt ?? 0) > Date.now(),
        );
      if (pending.length >= 10)
        fail(429, 'TOO_MANY_CAPTURES', '未完了の写真を投稿または削除してから撮影してください。');
      const s: StoredCapture = {
        id: crypto.randomUUID(),
        installationId: i.id,
        accountBindingId: i.accountBindingId,
        userId,
        nonce: token(),
        state: 'ISSUED',
        commitExpiresAt: Date.now() + capturePolicy.commitWindowMs,
      };
      this.records.put('capture:' + s.id, s);
      await this.schedule();
      return {
        sessionId: s.id,
        installationId: i.id,
        accountBindingId: i.accountBindingId,
        nonce: s.nonce,
        commitExpiresAt: s.commitExpiresAt,
      };
    });
  }
  commit(userId: string, id: string, input: unknown, proof: unknown) {
    const operation = this.commitQueue.then(() => this.commitOnce(userId, id, input, proof));
    this.commitQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private commitOnce(userId: string, id: string, input: unknown, proof: unknown) {
    return rpc(async () => {
      const parsed = manifestSchema.safeParse(input);
      if (!parsed.success) fail(400, 'INVALID_MANIFEST', '撮影記録の形式が正しくありません。');
      const manifest = parsed.data!;
      const digest = await manifestDigest(manifest);
      const s = this.capture(userId, id);
      if (s.digest) {
        if (['CANCELLED', 'EXPIRED', 'REJECTED'].includes(s.state))
          fail(409, 'CAPTURE_CLOSED', 'この撮影記録の処理は終了しています。');
        if (s.digest !== digest)
          fail(409, 'MANIFEST_CONFLICT', '別の撮影記録で再送することはできません。');
        return this.commitResponse(s);
      }
      try {
        assertCommitBinding(s, manifest, Date.now());
      } catch {
        fail(409, 'SESSION_INVALID', '撮影の有効時間が過ぎたか、撮影記録が一致しません。');
      }
      const i = this.active(userId),
        counter = await verifyCaptureProof(i, manifest, proof, this.env);
      // Reserve against the shared account before consuming the nonce. A crash leaves a bounded,
      // expiring reservation; an alarm releases it. SQLite CHECK enforces the quota atomically.
      const size = manifest.assets.reduce((n, a) => n + a.bytes, 0);
      try {
        await this.env.HOME.prepare(
          "INSERT INTO quota_reservations(capture_id,user_id,bytes,expires_at) SELECT ?,user_id,?,? FROM profiles WHERE user_id=? AND status='ACTIVE' ON CONFLICT(capture_id) DO NOTHING",
        )
          .bind(id, size, Date.now() + capturePolicy.uploadWindowMs, userId)
          .run();
      } catch {
        fail(409, 'QUOTA_EXCEEDED', '保存枠がいっぱいです。不要な投稿を削除してください。');
      }
      const reservation = await this.env.HOME.prepare(
        'SELECT bytes,state FROM quota_reservations WHERE capture_id=? AND user_id=?',
      )
        .bind(id, userId)
        .first<{ bytes: number; state: string }>();
      if (!reservation || reservation.bytes !== size || reservation.state !== 'RESERVED')
        fail(409, 'RESERVATION_CONFLICT', '保存枠を確保できませんでした。');
      const committed = this.records.atomic(() => {
        const current = this.capture(userId, id),
          installation = this.active(userId);
        if (['CANCELLED', 'EXPIRED', 'REJECTED'].includes(current.state))
          fail(409, 'CAPTURE_CLOSED', 'この撮影記録の処理は終了しています。');
        if (current.digest) {
          if (current.digest !== digest) fail(409, 'MANIFEST_CONFLICT', '撮影記録が競合しました。');
          return current;
        }
        try {
          assertCommitBinding(current, manifest, Date.now());
        } catch {
          fail(409, 'SESSION_EXPIRED', '撮影の有効時間が過ぎました。');
        }
        if (installation.platform === 'ios' && counter <= installation.counter)
          fail(409, 'ASSERTION_REPLAY', '端末認証の再利用を検出しました。');
        const next: StoredCapture = {
          ...current,
          state: 'COMMITTED',
          manifest,
          digest,
          committedAt: new Date().toISOString(),
          uploadExpiresAt: Date.now() + capturePolicy.uploadWindowMs,
        };
        this.records.put('installation', { ...installation, counter });
        this.records.put('capture:' + id, next);
        return next;
      });
      await this.schedule();
      return this.commitResponse(committed);
    });
  }
  private commitResponse(s: StoredCapture) {
    return {
      sessionId: s.id,
      state: s.state,
      manifestDigest: s.digest,
      uploadExpiresAt: s.uploadExpiresAt,
      assets: s.manifest!.assets.map((a) => ({ id: a.id, bytes: a.bytes, sha256: a.sha256 })),
    };
  }
  asset(userId: string, id: string, assetId: string) {
    return rpc(() => this.assetInfo(userId, id, assetId));
  }
  private assetInfo(userId: string, id: string, assetId: string) {
    const s = this.capture(userId, id);
    try {
      assertUploadWindow(s, Date.now());
    } catch {
      fail(409, 'UPLOAD_EXPIRED', 'アップロードの有効時間が過ぎました。');
    }
    const asset = s.manifest?.assets.find((a) => a.id === assetId);
    if (!asset) fail(404, 'ASSET_NOT_FOUND', '写真が見つかりません。');
    return { asset: asset!, key: stagingKey(s.installationId, id, assetId) };
  }
  beginMultipart(user: string, id: string, asset: string) {
    return rpc(() => this.uploads.begin(user, id, asset));
  }
  uploadPartInfo(user: string, id: string, asset: string, number: number, digest: string) {
    return rpc(() => this.uploads.part(user, id, asset, number, digest));
  }
  uploadedPart(
    user: string,
    id: string,
    asset: string,
    number: number,
    digest: string,
    part: R2UploadedPart,
  ) {
    return rpc(() => this.uploads.recordPart(user, id, asset, number, digest, part));
  }
  finishMultipart(user: string, id: string, asset: string) {
    return rpc(async () => {
      const { key } = this.assetInfo(user, id, asset);
      try {
        return await this.uploads.finish(user, id, asset);
      } finally {
        // R2 complete may have finished after the deletion sweep aborted the upload.
        if (this.records.get('account-deleted')) await this.env.STAGING.delete(key);
      }
    });
  }
  complete(userId: string, id: string) {
    return rpc(async () => {
      const s = this.capture(userId, id);
      try {
        if (s.state === 'VERIFIED') {
          await this.project(s);
          return this.publicStatus(s);
        }
        try {
          assertUploadWindow(s, Date.now());
        } catch {
          fail(409, 'UPLOAD_EXPIRED', 'アップロードの有効時間が過ぎました。');
        }
        for (const a of s.manifest!.assets)
          await freezeAsset(
            this.env.STAGING,
            this.env.ORIGINALS,
            stagingKey(s.installationId, id, a.id),
            originalKey(s.installationId, id, a),
            a,
          );
        const candidate = this.records.atomic(() => {
          const current = this.capture(userId, id);
          if (current.state === 'VERIFIED') return current;
          try {
            assertUploadWindow(current, Date.now());
          } catch {
            fail(409, 'CAPTURE_CANCELLED', '撮影記録の処理は終了しています。');
          }
          const verifiedAt = current.verifiedAt ?? new Date().toISOString();
          const payload = JSON.stringify({
            version: 1,
            captureId: id,
            installationId: s.installationId,
            manifestDigest: s.digest,
            clientCapturedAt: s.manifest!.clientCapturedAt,
            serverCommittedAt: s.committedAt,
            serverVerifiedAt: verifiedAt,
            environment: this.active(userId).environment,
            assets: s.manifest!.assets,
            scope: 'capture-record-and-file-consistency',
          });
          const next = {
            ...current,
            verifiedAt,
            receiptPayload: current.receiptPayload ?? payload,
          };
          this.records.put('capture:' + id, next);
          return next;
        });
        if (candidate.state === 'VERIFIED') return this.publicStatus(candidate);
        requireValue(this.env.RECEIPT_PRIVATE_JWK && this.env.RECEIPT_KEY_ID);
        const key = await importJWK(JSON.parse(this.env.RECEIPT_PRIVATE_JWK!), 'ES256');
        const receipt = await new CompactSign(new TextEncoder().encode(candidate.receiptPayload!))
          .setProtectedHeader({
            alg: 'ES256',
            kid: this.env.RECEIPT_KEY_ID,
            typ: 'justtaken-capture+jws',
          })
          .sign(key);
        const verified = this.records.atomic(() => {
          const current = this.capture(userId, id);
          if (current.state === 'VERIFIED') return current;
          try {
            assertUploadWindow(current, Date.now());
          } catch {
            fail(409, 'CAPTURE_CANCELLED', '撮影記録の処理は終了しています。');
          }
          const next: StoredCapture = { ...current, state: 'VERIFIED', receipt };
          this.records.put('capture:' + id, next);
          this.records.put('outbox:' + id, { userId, id });
          return next;
        });
        await this.project(verified);
        await this.schedule();
        return this.publicStatus(verified);
      } finally {
        // External R2/crypto awaits may interleave with purgeAccount. The durable marker wins.
        if (this.records.get('account-deleted') && s.manifest)
          for (const a of s.manifest.assets) {
            await this.env.STAGING.delete(stagingKey(s.installationId, id, a.id));
            await this.env.ORIGINALS.delete(originalKey(s.installationId, id, a));
          }
      }
    });
  }
  private async project(s: StoredCapture) {
    await this.env.HOME.batch([
      this.env.HOME.prepare(
        "UPDATE quota_reservations SET state='USED' WHERE capture_id=? AND state='RESERVED' AND EXISTS(SELECT 1 FROM profiles WHERE user_id=quota_reservations.user_id AND status='ACTIVE')",
      ).bind(s.id),
      this.env.HOME.prepare(
        "INSERT INTO capture_projection(capture_id,installation_id,revision,state,server_verified_at) SELECT ?,?,1,'VERIFIED',? FROM profiles WHERE user_id=? AND status='ACTIVE' ON CONFLICT(capture_id) DO NOTHING",
      ).bind(s.id, s.installationId, s.verifiedAt!, s.userId),
    ]);
    this.records.delete('outbox:' + s.id);
  }
  status(userId: string, id: string) {
    return rpc(() => this.publicStatus(this.capture(userId, id)));
  }
  snapshot(userId: string, id: string) {
    return rpc(() => this.capture(userId, id));
  }
  proofSource(userId: string, id: string) {
    return rpc(() => {
      const capture = this.capture(userId, id),
        installation = this.active(userId);
      if (capture.state !== 'VERIFIED' || !capture.receipt)
        fail(409, 'CAPTURE_NOT_VERIFIED', '撮影記録と原本の照合を完了してください。');
      return { capture, platform: installation.platform, environment: installation.environment };
    });
  }
  private publicStatus(s: StoredCapture) {
    return {
      sessionId: s.id,
      state: s.state,
      verifiedAt: s.verifiedAt,
      receipt: s.state === 'VERIFIED' ? s.receipt : undefined,
      uploadExpiresAt: s.uploadExpiresAt,
    };
  }
  cancel(userId: string, id: string) {
    return rpc(async () => {
      const s = this.records.atomic(() => {
        const current = this.capture(userId, id);
        const next = retiredCapture(current, 'CANCELLED');
        this.records.put('capture:' + id, next);
        this.records.put('cleanup:' + id, {
          userId,
          id,
          until: Math.max(Date.now(), current.uploadExpiresAt ?? 0) + 300_000,
          nextAt: Date.now() + 300_000,
        });
        return next;
      });
      await this.schedule();
      await this.removeProjection(id);
      await this.uploads.abort(id);
      if (s.manifest)
        for (const a of s.manifest.assets) {
          await this.env.STAGING.delete(stagingKey(s.installationId, id, a.id));
          await this.env.ORIGINALS.delete(originalKey(s.installationId, id, a));
        }
      return { cancelled: true };
    });
  }
  private async removeProjection(id: string) {
    await this.env.HOME.batch([
      this.env.HOME.prepare(
        "UPDATE quota_reservations SET state='RELEASED' WHERE capture_id=? AND state!='RELEASED'",
      ).bind(id),
      this.env.HOME.prepare(
        "UPDATE posts SET state='DELETED',revision=revision+1 WHERE capture_id=? AND state!='DELETED'",
      ).bind(id),
    ]);
  }
  private async schedule() {
    if (this.records.get('account-deleted')) return;
    const now = Date.now();
    let next = now + 86400_000;
    for (const row of this.records.all<StoredCapture>('capture:'))
      if (['ISSUED', 'COMMITTED', 'UPLOADING'].includes(row.value.state))
        next = Math.min(next, row.value.uploadExpiresAt ?? row.value.commitExpiresAt);
    for (const row of this.records.all<{ nextAt?: number; until: number }>('cleanup:'))
      next = Math.min(next, row.value.nextAt ?? row.value.until);
    if (this.records.all('outbox:').length) next = Math.min(next, now + 60_000);
    await this.ctx.storage.setAlarm(Math.max(now + 1000, next));
  }
  async alarm() {
    if (this.records.get('account-deleted')) return;
    const i = this.records.get<Installation>('installation');
    if (!i) return;
    if (!i.active) {
      await this.ctx.storage.deleteAll();
      return;
    }
    for (const event of this.records.all<{ userId: string; id: string }>('outbox:')) {
      if (this.records.get('account-deleted')) return;
      const s = this.capture(event.value.userId, event.value.id);
      if (s.state === 'VERIFIED') await this.project(s);
      else this.records.delete(event.key);
    }
    let pending = false;
    for (const cleanup of this.records.all<{
      userId: string;
      id: string;
      until: number;
      nextAt?: number;
    }>('cleanup:')) {
      if (this.records.get('account-deleted')) return;
      if ((cleanup.value.nextAt ?? 0) > Date.now()) {
        pending = true;
        continue;
      }
      const s = this.capture(cleanup.value.userId, cleanup.value.id);
      await this.removeProjection(s.id);
      await this.uploads.abort(s.id);
      if (s.manifest)
        for (const a of s.manifest.assets) {
          await this.env.STAGING.delete(stagingKey(s.installationId, s.id, a.id));
          await this.env.ORIGINALS.delete(originalKey(s.installationId, s.id, a));
        }
      if (this.records.get('account-deleted')) return;
      if (cleanup.value.until <= Date.now()) this.records.delete(cleanup.key);
      else {
        this.records.put(cleanup.key, { ...cleanup.value, nextAt: cleanup.value.until });
        pending = true;
      }
    }
    for (const row of this.records.all<StoredCapture>('capture:')) {
      if (this.records.get('account-deleted')) return;
      const s = row.value;
      if (['ISSUED', 'COMMITTED', 'UPLOADING'].includes(s.state)) {
        if ((s.uploadExpiresAt ?? s.commitExpiresAt) <= Date.now()) {
          this.records.put(row.key, retiredCapture(s, 'EXPIRED'));
          this.records.put('cleanup:' + s.id, {
            userId: s.userId,
            id: s.id,
            until: Date.now() + 300_000,
            nextAt: Date.now() + 300_000,
          });
          pending = true;
          await this.uploads.abort(s.id);
          await this.env.HOME.prepare(
            "UPDATE quota_reservations SET state='RELEASED' WHERE capture_id=? AND state='RESERVED'",
          )
            .bind(s.id)
            .run();
          if (s.manifest)
            for (const a of s.manifest.assets)
              await this.env.STAGING.delete(stagingKey(s.installationId, s.id, a.id));
        } else pending = true;
      }
    }
    if (pending || this.records.all('outbox:').length) await this.schedule();
  }
  purgeAccount(userId: string) {
    return rpc(async () => {
      const installation = this.records.get<Installation>('installation');
      if (installation && installation.userId !== userId)
        fail(409, 'OWNERSHIP_MISMATCH', 'アカウント情報が一致しません。');
      // Persist the barrier before any external await. Keep multipart IDs until abort succeeds.
      this.records.put('account-deleted', true);
      for (const row of this.records.all<StoredCapture>('capture:').slice(0, 50)) {
        await this.uploads.abort(row.value.id);
        this.records.atomic(() => {
          this.records.delete(row.key);
          this.records.delete('outbox:' + row.value.id);
          this.records.delete('cleanup:' + row.value.id);
        });
      }
      if (this.records.all('capture:').length) return { complete: false };
      this.records.atomic(() => {
        for (const row of this.records.all(''))
          if (row.key !== 'account-deleted') this.records.delete(row.key);
      });
      await this.ctx.storage.deleteAlarm();
      return { complete: true };
    });
  }
}
