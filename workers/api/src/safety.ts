import { bodyJSON, fail, json, unwrap, validID } from './http';
import { readPost, type PostRow } from './posts';
import { originalKey } from './media';
import type { Bindings, Principal } from './types';

import { communityRoutes } from './community';
import { reportReasons } from '@justtaken/contracts/community';
export function isModerator(env: Bindings, user: string) {
  return !!env.MODERATOR_USER_IDS?.split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .includes(user);
}
export async function safetyRoutes(request: Request, env: Bindings, principal: Principal) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method,
    user = principal.userId;
  const report = /^\/v1\/posts\/([A-Za-z0-9_-]+)\/reports$/.exec(path);
  if (report && method === 'POST') {
    const data = await bodyJSON(request, 4096),
      post = await readPost(env, report[1], user);
    if (post.author_id === user) fail(400, 'OWN_POST', '自分の投稿は削除できます。');
    if (
      !reportReasons.includes(data.reason) ||
      typeof data.details !== 'string' ||
      data.details.length > 1000
    )
      fail(400, 'INVALID_REPORT', '通報理由を選び、詳細を1,000文字以内で入力してください。');
    return communityRoutes(
      new Request(new URL('/v1/reports', request.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: post.author_id,
          postId: post.post_id,
          reason: data.reason,
          details: data.details,
        }),
      }),
      env,
      principal,
    );
  }
  if (/^\/v1\/blocks\/[A-Za-z0-9_-]+$/.test(path) && method === 'POST')
    return communityRoutes(new Request(request, { method: 'PUT' }), env, principal);
  if (!path.startsWith('/v1/moderation/')) return;
  if (!isModerator(env, user)) fail(403, 'MODERATOR_REQUIRED', '運営者のみ利用できます。');
  if (path === '/v1/moderation/queue' && method === 'GET') {
    const cursor = url.searchParams.get('cursor') ?? '';
    if (cursor && !validID(cursor)) fail(400, 'INVALID_CURSOR', '一覧を更新してください。');
    const rows = await env.HOME.prepare(
      `SELECT p.*,u.display_name FROM posts p JOIN profiles u ON u.user_id=p.author_id
      WHERE p.post_id>? AND u.status='ACTIVE' AND p.state!='DELETED' AND
      (p.moderation='PENDING' OR EXISTS(SELECT 1 FROM user_reports r WHERE r.post_id=p.post_id AND r.status IN ('received','under_review')))
      ORDER BY p.post_id LIMIT 21`,
    )
      .bind(cursor)
      .all<PostRow>();
    const posts = rows.results.slice(0, 20),
      reports = [];
    for (const post of posts) {
      const items = await env.HOME.prepare(
        "SELECT report_id,reason,details,created_at FROM user_reports WHERE post_id=? AND status IN ('received','under_review') ORDER BY created_at LIMIT 20",
      )
        .bind(post.post_id)
        .all();
      reports.push({ ...post, reports: items.results });
    }
    const deletions = await env.HOME.prepare(
      'SELECT COUNT(*) AS pending,COALESCE(MAX(attempts),0) AS maxAttempts FROM account_deletions',
    ).first();
    const accountReports = await env.HOME.prepare(
      `SELECT r.report_id,r.target_user_id,r.reason,r.details,r.created_at,u.display_name FROM user_reports r JOIN profiles u ON u.user_id=r.target_user_id WHERE r.target_kind IN ('user','comment') AND r.status IN ('received','under_review') AND u.status='ACTIVE' ORDER BY r.created_at LIMIT 20`,
    ).all();
    return json({
      accountReports: accountReports.results,
      posts: reports,
      nextCursor: rows.results.length > 20 ? posts.at(-1)!.post_id : null,
      deletions,
    });
  }
  const accountReport = /^\/v1\/moderation\/reports\/([A-Za-z0-9_-]+)\/decision$/.exec(path);
  if (accountReport && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (
      !['SUSPEND', 'DISMISS'].includes(data.action) ||
      typeof data.note !== 'string' ||
      !data.note.trim() ||
      data.note.length > 500
    )
      fail(400, 'DECISION_INVALID', '対応と理由を入力してください。');
    const report = await env.HOME.prepare(
      `SELECT target_user_id FROM user_reports WHERE report_id=? AND target_kind IN ('user','comment') AND status IN ('received','under_review')`,
    )
      .bind(accountReport[1])
      .first<{ target_user_id: string }>();
    if (!report) fail(409, 'REVIEW_CHANGED', 'この通報は対応済みです。一覧を更新してください。');
    const target = report!.target_user_id;
    if (isModerator(env, target))
      fail(
        409,
        'OPERATOR_REVIEW_REQUIRED',
        '運営アカウントへの通報は別の責任者が確認してください。',
      );
    const event = crypto.randomUUID(),
      now = Date.now();
    const statements = [
      env.HOME.prepare(
        `INSERT INTO account_review_audit(event_id,reviewer_id,target_user_id,report_id,action,note,created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user_reports WHERE report_id=? AND status IN ('received','under_review'))`,
      ).bind(
        event,
        user,
        target,
        accountReport[1],
        data.action,
        data.note.trim(),
        now,
        accountReport[1],
      ),
    ];
    if (data.action === 'SUSPEND')
      statements.push(
        env.HOME.prepare(
          `UPDATE profiles SET status='SUSPENDED',session_epoch=session_epoch+1,acl_revision=acl_revision+1 WHERE user_id=? AND status='ACTIVE' AND EXISTS(SELECT 1 FROM account_review_audit WHERE event_id=?)`,
        ).bind(target, event),
        env.HOME.prepare(
          `UPDATE posts SET state='HIDDEN',revision=revision+1 WHERE author_id=? AND state!='DELETED' AND EXISTS(SELECT 1 FROM account_review_audit WHERE event_id=?)`,
        ).bind(target, event),
        env.HOME.prepare(
          `UPDATE proof_shares SET revoked_at=? WHERE proof_id IN(SELECT proof_id FROM capture_proofs WHERE owner_id=?) AND EXISTS(SELECT 1 FROM account_review_audit WHERE event_id=?)`,
        ).bind(now, target, event),
      );
    statements.push(
      env.HOME.prepare(
        `UPDATE user_reports SET status=?,resolved_at=? WHERE report_id=? AND EXISTS(SELECT 1 FROM account_review_audit WHERE event_id=?)`,
      ).bind(
        data.action === 'SUSPEND' ? 'actioned' : 'dismissed',
        new Date(now).toISOString(),
        accountReport[1],
        event,
      ),
    );
    const result = await env.HOME.batch(statements);
    if (!result[0].meta.changes) fail(409, 'REVIEW_CHANGED', 'この通報は対応済みです。');
    return json({ saved: true });
  }
  const match = /^\/v1\/moderation\/posts\/([A-Za-z0-9_-]+)\/(decision|media)$/.exec(path);
  if (!match) fail(404, 'NOT_FOUND', '操作が見つかりません。');
  const post = await env.HOME.prepare(
    `SELECT p.* FROM posts p JOIN profiles u ON u.user_id=p.author_id
    WHERE p.post_id=? AND p.state!='DELETED' AND u.status='ACTIVE'`,
  )
    .bind(match![1])
    .first<PostRow>();
  if (!post) fail(404, 'POST_NOT_FOUND', '投稿が見つかりません。');
  const capture = unwrap(
    await env.CAPTURE.getByName(post!.installation_id).snapshot(post!.author_id, post!.capture_id),
  );
  if (capture.state !== 'VERIFIED')
    fail(409, 'CAPTURE_NOT_READY', '撮影データの確認が完了していません。');
  if (match![2] === 'media' && method === 'GET') {
    const asset = capture.manifest!.assets.find((a) => a.id === 'original')!;
    const object = await env.ORIGINALS.get(
      originalKey(post!.installation_id, post!.capture_id, asset),
      { range: request.headers },
    );
    if (!object) fail(404, 'MEDIA_NOT_FOUND', 'ファイルが見つかりません。');
    const headers = new Headers({
      'Content-Type': asset.mime,
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
    });
    if (object!.range && 'offset' in object!.range) {
      const offset = object!.range.offset ?? 0,
        length = object!.range.length ?? object!.size - offset;
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object!.size}`);
    }
    headers.set(
      'Content-Length',
      String(object!.range && 'length' in object!.range ? object!.range.length : object!.size),
    );
    return new Response(object!.body, { status: object!.range ? 206 : 200, headers });
  }
  if (match![2] === 'decision' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (
      !['ALLOWED', 'BLOCKED', 'DISMISS'].includes(data.action) ||
      typeof data.note !== 'string' ||
      !data.note.trim() ||
      data.note.length > 500 ||
      data.revision !== post!.revision
    )
      fail(409, 'DECISION_INVALID', '一覧を更新し、対応理由を入力してください。');
    if (data.action === 'DISMISS' && post!.moderation === 'PENDING')
      fail(409, 'REVIEW_REQUIRED', '未確認の投稿は掲載可否を判断してください。');
    // Revision check is repeated in SQL; concurrent reviewer actions never silently overwrite.
    const event = crypto.randomUUID(),
      now = Date.now();
    const statements = [
      env.HOME.prepare(
        `INSERT INTO review_audit(event_id,reviewer_id,post_id,action,note,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM posts p JOIN profiles u ON u.user_id=p.author_id
        WHERE p.post_id=? AND p.revision=? AND p.state!='DELETED' AND u.status='ACTIVE')`,
      ).bind(
        event,
        user,
        post!.post_id,
        data.action,
        data.note.trim(),
        now,
        post!.post_id,
        data.revision,
      ),
    ];
    if (data.action !== 'DISMISS')
      statements.push(
        env.HOME.prepare(
          `INSERT INTO moderation_decisions(capture_id,decision,reviewer_id,decided_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM review_audit WHERE event_id=?)
        ON CONFLICT(capture_id) DO UPDATE SET decision=excluded.decision,reviewer_id=excluded.reviewer_id,decided_at=excluded.decided_at`,
        ).bind(post!.capture_id, data.action, user, new Date(now).toISOString(), event),
        env.HOME.prepare(
          `UPDATE posts SET state=?,moderation=?,revision=revision+1,server_verified_at=?,published_at=COALESCE(published_at,?)
        WHERE post_id=? AND EXISTS(SELECT 1 FROM review_audit WHERE event_id=?)`,
        ).bind(
          data.action === 'ALLOWED' ? 'PUBLISHED' : 'HIDDEN',
          data.action,
          capture.verifiedAt!,
          new Date(now).toISOString(),
          post!.post_id,
          event,
        ),
      );
    if (data.action === 'DISMISS')
      statements.push(
        env.HOME.prepare(
          `UPDATE posts SET revision=revision+1 WHERE post_id=? AND EXISTS(SELECT 1 FROM review_audit WHERE event_id=?)`,
        ).bind(post!.post_id, event),
      );
    statements.push(
      env.HOME.prepare(
        `UPDATE user_reports SET status=?,resolved_at=? WHERE post_id=? AND status IN ('received','under_review')
      AND EXISTS(SELECT 1 FROM review_audit WHERE event_id=?)`,
      ).bind(
        data.action === 'BLOCKED' ? 'actioned' : 'dismissed',
        new Date(now).toISOString(),
        post!.post_id,
        event,
      ),
    );
    const result = await env.HOME.batch(statements);
    if (!result[0].meta.changes)
      fail(409, 'REVIEW_CHANGED', '他の対応が先に保存されました。一覧を更新してください。');
    return json({ saved: true });
  }
  fail(405, 'METHOD_NOT_ALLOWED', 'この操作は利用できません。');
}
