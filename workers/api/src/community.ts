import {
  communityPolicy,
  consentInputSchema,
  reportInputSchema,
  type ConsentState,
} from '@justtaken/contracts/community';
import { bodyJSON, fail, json, validID } from './http';
import { readPost } from './posts';
import type { Bindings, Principal } from './types';

type ConsentRow = {
  terms_version: string;
  privacy_version: string;
  accepted_at: string;
  age_confirmation_version: string | null;
  age_confirmed_at: string | null;
};

export async function consentState(env: Bindings, userId: string): Promise<ConsentState> {
  const row = await env.HOME.prepare(
    'SELECT terms_version,privacy_version,accepted_at,age_confirmation_version,age_confirmed_at FROM user_consents WHERE user_id=?',
  )
    .bind(userId)
    .first<ConsentRow>();
  const ageConfirmed18Plus =
    row?.age_confirmation_version === communityPolicy.ageConfirmationVersion &&
    !!row.age_confirmed_at;
  const accepted =
    ageConfirmed18Plus &&
    row?.terms_version === communityPolicy.termsVersion &&
    row?.privacy_version === communityPolicy.privacyVersion;
  return {
    required: !accepted,
    accepted,
    termsVersion: communityPolicy.termsVersion,
    privacyVersion: communityPolicy.privacyVersion,
    acceptedAt: accepted ? row!.accepted_at : null,
    minimumAge: communityPolicy.minimumAge,
    ageAssurance: communityPolicy.ageAssurance,
    ageConfirmed18Plus,
    ageConfirmedAt: ageConfirmed18Plus ? row!.age_confirmed_at : null,
  };
}

export async function requireCommunityConsent(env: Bindings, userId: string) {
  if (!(await consentState(env, userId)).accepted)
    fail(403, 'CONSENT_REQUIRED', '利用規約とプライバシーポリシーを確認して同意してください。');
}

async function activeTarget(env: Bindings, userId: string, current: string) {
  if (!validID(userId)) fail(400, 'INVALID_USER', '対象のユーザーを確認してください。');
  if (userId === current) fail(400, 'SELF_TARGET', '自分自身は対象にできません。');
  const target = await env.HOME.prepare(
    "SELECT user_id FROM profiles WHERE user_id=? AND status='ACTIVE'",
  )
    .bind(userId)
    .first();
  if (!target) fail(404, 'USER_NOT_FOUND', '対象のユーザーが見つかりません。');
}

export async function communityRoutes(
  request: Request,
  env: Bindings,
  principal: Principal,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/v1/me/consent' && method === 'GET')
    return json(await consentState(env, principal.userId));
  if (path === '/v1/me/consent' && method === 'POST') {
    const data = await bodyJSON(request, 2048);
    if (data.ageConfirmed18Plus !== true)
      fail(403, 'AGE_CONFIRMATION_REQUIRED', '18歳以上であることをご自身で確認してください。');
    const parsed = consentInputSchema.safeParse(data);
    if (!parsed.success)
      fail(
        400,
        'CONSENT_VERSION_MISMATCH',
        '最新の利用規約とプライバシーポリシーを確認してください。',
      );
    const acceptedAt = new Date().toISOString();
    await env.HOME.prepare(
      `INSERT INTO user_consents(user_id,terms_version,privacy_version,accepted_at,age_confirmation_version,age_confirmed_at)
       SELECT user_id,?,?,?,?,? FROM profiles WHERE user_id=? AND status='ACTIVE'
       ON CONFLICT(user_id) DO UPDATE SET terms_version=excluded.terms_version,
       privacy_version=excluded.privacy_version,accepted_at=excluded.accepted_at,
       age_confirmation_version=excluded.age_confirmation_version,age_confirmed_at=excluded.age_confirmed_at
       WHERE user_consents.terms_version!=excluded.terms_version OR user_consents.privacy_version!=excluded.privacy_version
         OR user_consents.age_confirmation_version IS NOT excluded.age_confirmation_version
         OR user_consents.age_confirmed_at IS NULL`,
    )
      .bind(
        parsed.data.termsVersion,
        parsed.data.privacyVersion,
        acceptedAt,
        communityPolicy.ageConfirmationVersion,
        acceptedAt,
        principal.userId,
      )
      .run();
    return json(await consentState(env, principal.userId));
  }
  if (path === '/v1/reports' && method === 'POST') {
    const parsed = reportInputSchema.safeParse(await bodyJSON(request, 16_384));
    if (!parsed.success)
      fail(400, 'INVALID_REPORT', '通報内容を確認してください。補足は2,000文字以内です。');
    const data = parsed.data;
    await activeTarget(env, data.userId, principal.userId);
    let commentDetails: string | undefined;
    if (data.commentId) {
      if (data.postId) fail(400, 'INVALID_REPORT', '通報対象を一つ選んでください。');
      const comment = await env.HOME.prepare(
        'SELECT post_id,user_id,body FROM post_comments WHERE comment_id=?',
      )
        .bind(data.commentId)
        .first<{ post_id: string; user_id: string; body: string }>();
      if (!comment || comment.user_id !== data.userId)
        fail(404, 'COMMENT_NOT_FOUND', 'コメントが見つかりません。');
      await readPost(env, comment.post_id, principal.userId);
      const blocked = await env.HOME.prepare(
        'SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)',
      )
        .bind(principal.userId, data.userId, data.userId, principal.userId)
        .first();
      if (blocked) fail(404, 'COMMENT_NOT_FOUND', 'コメントが見つかりません。');
      // Snapshot server-read evidence so a deleted comment can still be reviewed.
      commentDetails = `コメントID: ${data.commentId}\n投稿ID: ${comment.post_id}\n本文: ${Array.from(comment.body).slice(0, 250).join('')}\n通報詳細: ${Array.from(data.details).slice(0, 500).join('')}`;
    }
    if (data.postId) {
      const post = await readPost(env, data.postId, principal.userId);
      if (post.author_id !== data.userId)
        fail(404, 'POST_NOT_FOUND', '対象の投稿が見つかりません。');
    }
    const targetKind = data.postId ? 'post' : data.commentId ? 'comment' : 'user';
    const targetId = data.postId ?? data.commentId ?? data.userId;
    const findExisting = () =>
      env.HOME.prepare(
        'SELECT report_id FROM user_reports WHERE reporter_id=? AND target_kind=? AND target_id=? AND reason=?',
      )
        .bind(principal.userId, targetKind, targetId, data.reason)
        .first<{ report_id: string }>();
    const existing = await findExisting();
    if (existing) return json({ reportId: existing.report_id, status: 'received' });
    const now = Date.now();
    // The rate check and write are one SQLite statement, so concurrent requests cannot overrun it.
    const result = await env.HOME.prepare(
      `INSERT OR IGNORE INTO user_reports(report_id,reporter_id,target_user_id,target_kind,target_id,post_id,comment_id,reason,details,created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?
       WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='ACTIVE')
         AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='ACTIVE')
         AND (SELECT COUNT(*) FROM user_reports WHERE reporter_id=? AND created_at>=?)<20
         AND (SELECT COUNT(*) FROM user_reports WHERE reporter_id=? AND created_at>=?)<100`,
    )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        data.userId,
        targetKind,
        targetId,
        data.postId ?? null,
        data.commentId ?? null,
        data.reason,
        commentDetails ?? data.details,
        new Date(now).toISOString(),
        principal.userId,
        data.userId,
        principal.userId,
        new Date(now - 3_600_000).toISOString(),
        principal.userId,
        new Date(now - 86_400_000).toISOString(),
      )
      .run();
    const saved = await findExisting();
    if (!saved)
      fail(429, 'REPORT_LIMIT', '通報の送信回数が上限に達しました。時間をおいてお試しください。');
    return json({ reportId: saved.report_id, status: 'received' }, result.meta.changes ? 201 : 200);
  }
  if (path === '/v1/blocks' && method === 'GET') {
    const rows = await env.HOME.prepare(
      'SELECT b.blocked_id AS userId,p.display_name AS displayName FROM blocks b JOIN profiles p ON p.user_id=b.blocked_id WHERE b.blocker_id=? ORDER BY p.display_name,b.blocked_id LIMIT 1000',
    )
      .bind(principal.userId)
      .all<{ userId: string; displayName: string }>();
    return json({ blocks: rows.results });
  }
  const block = /^\/v1\/blocks\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (block && method === 'PUT') {
    await activeTarget(env, block[1], principal.userId);
    // Removing both follow relationships in the same batch prevents them reappearing on unblock.
    await env.HOME.batch([
      env.HOME.prepare(
        `INSERT OR IGNORE INTO blocks(blocker_id,blocked_id) SELECT ?,?
         WHERE (SELECT COUNT(*) FROM blocks WHERE blocker_id=?)<1000
           AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='ACTIVE')
           AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='ACTIVE')`,
      ).bind(principal.userId, block[1], principal.userId, principal.userId, block[1]),
      env.HOME.prepare(
        `UPDATE followers SET state='REMOVED',revision=revision+1
         WHERE ((target_id=? AND follower_id=?) OR (target_id=? AND follower_id=?))
           AND EXISTS(SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?) AND state!='REMOVED'`,
      ).bind(principal.userId, block[1], block[1], principal.userId, principal.userId, block[1]),
    ]);
    const present = await env.HOME.prepare(
      'SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?',
    )
      .bind(principal.userId, block[1])
      .first();
    if (!present)
      fail(
        409,
        'BLOCK_LIMIT',
        'ブロックできる件数の上限に達しました。設定から一覧を確認してください。',
      );
    return json({ blocked: true });
  }
  if (block && method === 'DELETE') {
    if (block[1] === principal.userId) fail(400, 'SELF_TARGET', '自分自身は対象にできません。');
    await env.HOME.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?')
      .bind(principal.userId, block[1])
      .run();
    return json({ blocked: false });
  }
}
