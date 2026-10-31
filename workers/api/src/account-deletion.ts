import { capturePolicy } from '@justtaken/contracts/policy';
import { bodyJSON, fail, json, sha, unwrap } from './http';
import type { Bindings, Principal } from './types';
import { revokeProviderToken } from './provider-tokens';

export async function deletionStatus(request: Request, env: Bindings) {
  if (new URL(request.url).pathname !== '/v1/account/deletion-status' || request.method !== 'POST')
    return;
  const data = await bodyJSON(request, 1024);
  if (typeof data.receipt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.receipt))
    fail(404, 'NOT_FOUND', '削除の受付記録が見つかりません。');
  const receipt = await env.HOME.prepare(
    'SELECT status,requested_at,completed_at,provider_revocation FROM account_deletion_receipts WHERE receipt_hash=?',
  )
    .bind(await sha(data.receipt))
    .first();
  if (!receipt) fail(404, 'NOT_FOUND', '削除の受付記録が見つかりません。');
  return json(receipt);
}

// One old refresh token lives at most 30 days; the extra day covers expiry/cleanup scheduling.
export const deletionBarrierMs = 31 * 86400_000;
const sweepDelayMs = capturePolicy.uploadWindowMs + 300_000;
type Job = {
  receipt_id: string;
  user_id: string;
  requested_at: string;
  sweep_after: number;
  round: number;
  attempts: number;
};

async function register(
  env: Bindings,
  table: 'user_installations' | 'user_auth_sessions',
  column: 'installation_id' | 'session_id',
  userId: string,
  id: string,
) {
  await env.HOME.prepare(
    `INSERT OR IGNORE INTO ${table}(${column},user_id)
     SELECT ?,user_id FROM profiles WHERE user_id=? AND status='ACTIVE'`,
  )
    .bind(id, userId)
    .run();
  const row = await env.HOME.prepare(
    `SELECT 1 AS found FROM ${table} r JOIN profiles p ON p.user_id=r.user_id
     WHERE r.${column}=? AND r.user_id=? AND p.status='ACTIVE'`,
  )
    .bind(id, userId)
    .first();
  if (!row) fail(403, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
}
export const registerInstallation = (env: Bindings, userId: string, id: string) =>
  register(env, 'user_installations', 'installation_id', userId, id);
export const registerAuthSession = (env: Bindings, userId: string, id: string) =>
  register(env, 'user_auth_sessions', 'session_id', userId, id);

export async function accountDeletionRoutes(request: Request, env: Bindings, principal: Principal) {
  const path = new URL(request.url).pathname;
  const receiptFlow = path === '/v1/me' && request.method === 'DELETE';
  if (!receiptFlow && !(path === '/v1/me/deletion' && request.method === 'POST')) return;
  const data = await bodyJSON(request, 1024);
  if (
    data.confirmation !== 'DELETE' ||
    (receiptFlow
      ? typeof data.receipt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.receipt)
      : Object.keys(data).length !== 1)
  )
    fail(400, 'DELETION_CONFIRMATION_REQUIRED', 'アカウント削除の確認が必要です。');
  const now = Date.now(),
    requestedAt = new Date(now).toISOString(),
    receiptId = crypto.randomUUID();
  const user = principal.userId,
    hash = await sha(user);
  // D1 batch is atomic: never acknowledge before all devices and shares are revoked.
  const statements = [
    env.HOME.prepare(
      `INSERT OR IGNORE INTO account_deletions(receipt_id,user_id,requested_at,sweep_after)
      SELECT ?,user_id,?,? FROM profiles WHERE user_id=? AND status='ACTIVE'`,
    ).bind(receiptId, requestedAt, now + sweepDelayMs, user),
    env.HOME.prepare(
      `INSERT INTO deleted_accounts(user_id_hash,expires_at) VALUES(?,?)
      ON CONFLICT(user_id_hash) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`,
    ).bind(hash, now + deletionBarrierMs),
    env.HOME.prepare(
      `UPDATE profiles SET status='DELETED',session_epoch=session_epoch+1,
      acl_revision=acl_revision+1 WHERE user_id=? AND status='ACTIVE'`,
    ).bind(user),
    env.HOME.prepare(
      `UPDATE proof_shares SET revoked_at=? WHERE revoked_at IS NULL AND
      proof_id IN (SELECT proof_id FROM capture_proofs WHERE owner_id=?)`,
    ).bind(now, user),
    env.HOME.prepare(
      `UPDATE posts SET state='DELETED',revision=revision+1 WHERE author_id=?
      AND state!='DELETED'`,
    ).bind(user),
    // Legacy sessions have no index; at least the submitting session is known.
    env.HOME.prepare(
      'INSERT OR IGNORE INTO user_auth_sessions(session_id,user_id) VALUES(?,?)',
    ).bind(principal.sessionId, user),
  ];
  if (receiptFlow)
    statements.push(
      env.HOME.prepare(
        'INSERT INTO account_deletion_receipts(receipt_hash,receipt_id,requested_at) VALUES(?,?,?)',
      ).bind(await sha(data.receipt), receiptId, now),
    );
  await env.HOME.batch(statements);
  const saved = await env.HOME.prepare(
    'SELECT receipt_id,requested_at FROM account_deletions WHERE user_id=?',
  )
    .bind(user)
    .first<{ receipt_id: string; requested_at: string }>();
  if (!saved) fail(409, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
  return json(
    {
      receiptId: saved!.receipt_id,
      status: receiptFlow ? 'PENDING' : 'pending',
      requestedAt: saved!.requested_at,
    },
    202,
  );
}

async function discoverLegacyInstallations(env: Bindings, user: string) {
  await env.HOME.batch([
    env.HOME.prepare(
      `INSERT OR IGNORE INTO user_installations(installation_id,user_id)
      SELECT installation_id,author_id FROM posts WHERE author_id=? AND installation_id IS NOT NULL`,
    ).bind(user),
    env.HOME.prepare(
      `INSERT OR IGNORE INTO user_installations(installation_id,user_id)
      SELECT installation_id,owner_id FROM capture_proofs WHERE owner_id=?`,
    ).bind(user),
    env.HOME.prepare(
      `INSERT OR IGNORE INTO user_installations(installation_id,user_id)
      SELECT c.installation_id,q.user_id FROM capture_projection c JOIN quota_reservations q
      ON c.capture_id=q.capture_id WHERE q.user_id=?`,
    ).bind(user),
  ]);
}

// Start from the beginning after each deletion; cursors can skip objects while a list is changing.
async function sweepPrefix(bucket: R2Bucket, prefix: string) {
  const page = await bucket.list({ prefix, limit: 500 });
  if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
  return !page.truncated;
}

async function purgeRows(env: Bindings, user: string) {
  const captures = `SELECT capture_id FROM quota_reservations WHERE user_id=?
    UNION SELECT capture_id FROM posts WHERE author_id=?
    UNION SELECT capture_id FROM capture_proofs WHERE owner_id=?`;
  await env.HOME.batch([
    env.HOME.prepare(
      'DELETE FROM account_review_audit WHERE reviewer_id=? OR target_user_id=?',
    ).bind(user, user),
    env.HOME.prepare(
      'DELETE FROM review_audit WHERE reviewer_id=? OR post_id IN (SELECT post_id FROM posts WHERE author_id=?)',
    ).bind(user, user),
    env.HOME.prepare(
      `DELETE FROM moderation_audit WHERE capture_id IN (${captures}) OR report_id IN
      (SELECT report_id FROM user_reports WHERE reporter_id=? OR target_user_id=?)`,
    ).bind(user, user, user, user, user),
    env.HOME.prepare(
      `DELETE FROM proof_shares WHERE proof_id IN (SELECT proof_id FROM capture_proofs WHERE owner_id=?)`,
    ).bind(user),
    env.HOME.prepare(
      `DELETE FROM proof_anchors WHERE proof_id IN (SELECT proof_id FROM capture_proofs WHERE owner_id=?)`,
    ).bind(user),
    env.HOME.prepare(`DELETE FROM moderation_decisions WHERE capture_id IN (${captures})`).bind(
      user,
      user,
      user,
    ),
    env.HOME.prepare(
      `DELETE FROM capture_projection WHERE capture_id IN (${captures}) OR installation_id IN
      (SELECT installation_id FROM user_installations WHERE user_id=?)`,
    ).bind(user, user, user, user),
    env.HOME.prepare('DELETE FROM capture_proofs WHERE owner_id=?').bind(user),
    env.HOME.prepare('DELETE FROM user_reports WHERE reporter_id=? OR target_user_id=?').bind(
      user,
      user,
    ),
    env.HOME.prepare('DELETE FROM social_notifications WHERE recipient_id=? OR actor_id=?').bind(
      user,
      user,
    ),
    env.HOME.prepare('DELETE FROM post_comments WHERE user_id=?').bind(user),
    env.HOME.prepare('DELETE FROM post_likes WHERE user_id=?').bind(user),
    env.HOME.prepare('DELETE FROM post_saves WHERE user_id=?').bind(user),
    env.HOME.prepare('DELETE FROM posts WHERE author_id=?').bind(user),
    env.HOME.prepare('DELETE FROM followers WHERE target_id=? OR follower_id=?').bind(user, user),
    env.HOME.prepare('DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?').bind(user, user),
    env.HOME.prepare('DELETE FROM user_consents WHERE user_id=?').bind(user),
    env.HOME.prepare(
      "UPDATE quota_reservations SET state='RELEASED' WHERE user_id=? AND state!='RELEASED'",
    ).bind(user),
    env.HOME.prepare('DELETE FROM quota_reservations WHERE user_id=?').bind(user),
    env.HOME.prepare('DELETE FROM quota_accounts WHERE user_id=?').bind(user),
  ]);
}

async function processJob(env: Bindings, job: Job) {
  const user = job.user_id;
  await discoverLegacyInstallations(env, user);
  const sessions = await env.HOME.prepare(
    'SELECT session_id FROM user_auth_sessions WHERE user_id=? AND purged=0 LIMIT 20',
  )
    .bind(user)
    .all<{ session_id: string }>();
  for (const row of sessions.results) {
    unwrap(await env.AUTH.getByName(row.session_id).purgeAccount(user));
    await env.HOME.prepare(
      'UPDATE user_auth_sessions SET purged=1 WHERE session_id=? AND user_id=?',
    )
      .bind(row.session_id, user)
      .run();
  }
  const installations = await env.HOME.prepare(
    'SELECT installation_id FROM user_installations WHERE user_id=? AND swept_round<? LIMIT 5',
  )
    .bind(user, job.round)
    .all<{ installation_id: string }>();
  for (const row of installations.results) {
    const result = unwrap(await env.CAPTURE.getByName(row.installation_id).purgeAccount(user));
    const staging = await sweepPrefix(env.STAGING, row.installation_id + '/');
    const originals = await sweepPrefix(env.ORIGINALS, row.installation_id + '/');
    if (result.complete && staging && originals)
      await env.HOME.prepare(
        'UPDATE user_installations SET swept_round=? WHERE installation_id=? AND user_id=?',
      )
        .bind(job.round, row.installation_id, user)
        .run();
  }
  const pending = await env.HOME.prepare(
    `SELECT 1 AS found FROM user_installations WHERE user_id=? AND swept_round<?
    UNION ALL SELECT 1 FROM user_auth_sessions WHERE user_id=? AND purged=0 LIMIT 1`,
  )
    .bind(user, job.round, user)
    .first();
  if (pending) return Date.now() + 60_000;
  await purgeRows(env, user);
  const credential = await env.HOME.prepare(
    'SELECT provider,token_ciphertext FROM provider_credentials WHERE user_id=?',
  )
    .bind(user)
    .first<{ provider: string; token_ciphertext: string }>();
  if (credential)
    await revokeProviderToken(env, user, credential.provider, credential.token_ciphertext);
  await env.HOME.batch([
    env.HOME.prepare('DELETE FROM provider_credentials WHERE user_id=?').bind(user),
    env.HOME.prepare(
      `UPDATE account_deletion_receipts SET provider_revocation=? WHERE receipt_id=? AND provider_revocation='PENDING'`,
    ).bind(credential ? 'REVOKED' : 'MANUAL_REQUIRED', job.receipt_id),
    env.HOME.prepare("DELETE FROM profiles WHERE user_id=? AND status='DELETED'").bind(user),
  ]);
  if (job.round === 1) {
    await env.HOME.prepare('UPDATE account_deletions SET round=2 WHERE receipt_id=?')
      .bind(job.receipt_id)
      .run();
    return Math.max(Date.now() + 60_000, job.sweep_after);
  }
  // The completed receipt is deliberately not kept as an account-linked audit trail.
  await env.HOME.batch([
    env.HOME.prepare(
      "UPDATE account_deletion_receipts SET status='COMPLETE',completed_at=? WHERE receipt_id=?",
    ).bind(Date.now(), job.receipt_id),
    env.HOME.prepare('DELETE FROM user_installations WHERE user_id=?').bind(user),
    env.HOME.prepare('DELETE FROM user_auth_sessions WHERE user_id=?').bind(user),
    env.HOME.prepare('DELETE FROM account_deletions WHERE receipt_id=?').bind(job.receipt_id),
  ]);
  return undefined;
}

export async function processAccountDeletions(env: Bindings): Promise<void> {
  const now = Date.now();
  const jobs = await env.HOME.prepare(
    'SELECT * FROM account_deletions WHERE next_attempt<=? AND lease_until<=? ORDER BY next_attempt LIMIT 5',
  )
    .bind(now, now)
    .all<Job>();
  for (const job of jobs.results) {
    const lease = crypto.randomUUID();
    const claimed = await env.HOME.prepare(
      `UPDATE account_deletions SET lease_id=?,lease_until=?,attempts=attempts+1
      WHERE receipt_id=? AND lease_until<=?`,
    )
      .bind(lease, now + 900_000, job.receipt_id, now)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      const next = await processJob(env, job);
      if (next !== undefined)
        await env.HOME.prepare(
          `UPDATE account_deletions SET next_attempt=?,lease_id=NULL,lease_until=0,last_error=NULL
        WHERE receipt_id=? AND lease_id=?`,
        )
          .bind(next, job.receipt_id, lease)
          .run();
    } catch {
      // Never include provider responses, tokens, file paths, or personal details in the retry log.
      await env.HOME.prepare(
        `UPDATE account_deletions SET next_attempt=?,lease_id=NULL,lease_until=0,last_error='PURGE_RETRY'
        WHERE receipt_id=? AND lease_id=?`,
      )
        .bind(
          now + Math.min(3600_000, 60_000 * 2 ** Math.min(job.attempts, 6)),
          job.receipt_id,
          lease,
        )
        .run();
      console.error('account_deletion_retry', { receiptId: job.receipt_id });
    }
  }
  // Keep barriers while any deletion is unfinished. This conservative rule needs no raw user ID in the tombstone.
  await env.HOME.prepare(
    'DELETE FROM deleted_accounts WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM account_deletions)',
  )
    .bind(now)
    .run();
  await env.HOME.prepare(
    "DELETE FROM account_deletion_receipts WHERE status='COMPLETE' AND completed_at<?",
  )
    .bind(now - 30 * 86400_000)
    .run();
}
