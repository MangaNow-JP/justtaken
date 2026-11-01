import { countGraphemes } from '@justtaken/contracts';
import { bodyJSON, fail, json, validID } from './http';
import { readPost } from './posts';
import type { Bindings, Principal } from './types';

// SQL expressions only; user input is always bound. These predicates are also used
// inside writes so privacy changes, suspension and blocks cannot race a preflight read.
export const unblocked = (a: string, b: string) =>
  `NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=${a} AND b.blocked_id=${b}) OR (b.blocker_id=${b} AND b.blocked_id=${a}))`;
export const visiblePost = (viewer = '?1') =>
  `u.status='ACTIVE' AND ${unblocked(viewer, 'p.author_id')} AND
   (p.author_id=${viewer} AND p.state NOT IN ('DELETED','HIDDEN') OR
    p.state='PUBLISHED' AND p.visibility!='private' AND
    (u.is_private=0 AND p.visibility='public' OR EXISTS(SELECT 1 FROM followers f WHERE f.target_id=p.author_id AND f.follower_id=${viewer} AND f.state='APPROVED')))`;
const userFields = `u.user_id AS userId,u.display_name AS displayName,u.is_private AS isPrivate,
  COALESCE((SELECT state FROM followers WHERE target_id=u.user_id AND follower_id=?1),'REMOVED') AS relationship`;
const visibleUser = `u.status='ACTIVE' AND ${unblocked('?1', 'u.user_id')}`;
const socialFields = `
  (SELECT COUNT(*) FROM post_likes l JOIN profiles a ON a.user_id=l.user_id WHERE l.post_id=p.post_id AND a.status='ACTIVE' AND ${unblocked('?1', 'l.user_id')}) AS like_count,
  (SELECT COUNT(*) FROM post_comments c JOIN profiles a ON a.user_id=c.user_id WHERE c.post_id=p.post_id AND a.status='ACTIVE' AND ${unblocked('?1', 'c.user_id')}) AS comment_count,
  EXISTS(SELECT 1 FROM post_likes WHERE post_id=p.post_id AND user_id=?1) AS liked,
  EXISTS(SELECT 1 FROM post_saves WHERE post_id=p.post_id AND user_id=?1) AS saved`;
export async function socialPosts(env: Bindings, posts: { post_id: string }[], viewer: string) {
  if (!posts.length) return posts;
  const rows = await env.HOME.prepare(
    `SELECT p.post_id,${socialFields} FROM posts p WHERE p.post_id IN (${posts.map((_, i) => '?' + (i + 2)).join(',')})`,
  )
    .bind(viewer, ...posts.map((p) => p.post_id))
    .all();
  return posts.map((p) => ({ ...p, ...rows.results.find((r) => r.post_id === p.post_id) }));
}
function cursor(url: URL) {
  if (!url.searchParams.has('cursor')) return { at: '9999', id: '~' };
  try {
    const raw = url.searchParams.get('cursor')!;
    if (raw.length > 1024) throw new Error();
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (
      typeof c.at !== 'string' ||
      c.at.length > 40 ||
      typeof c.id !== 'string' ||
      c.id.length > 400
    )
      throw new Error();
    return c as { at: string; id: string };
  } catch {
    return fail(400, 'INVALID_CURSOR', '一覧を更新してください。');
  }
}
function page<T extends Record<string, any>>(rows: T[], key: string) {
  const items = rows.slice(0, 20),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(JSON.stringify({ at: last.created_at, id: last[key] })).toString('base64url')
        : null,
  };
}
async function user(env: Bindings, viewer: string, target: string) {
  const row = await env.HOME.prepare(
    `SELECT ${userFields},CASE WHEN u.user_id=?1 OR u.is_private=0 OR EXISTS(
       SELECT 1 FROM followers f WHERE f.target_id=u.user_id AND f.follower_id=?1 AND f.state='APPROVED'
     ) THEN u.bio ELSE '' END AS bio FROM profiles u WHERE u.user_id=?2 AND ${visibleUser}`,
  )
    .bind(viewer, target)
    .first<{
      userId: string;
      displayName: string;
      bio: string;
      isPrivate: number;
      relationship: string;
    }>();
  if (!row) fail(404, 'USER_NOT_FOUND', 'ユーザーが見つかりません。');
  return row;
}
const notificationVisible = `n.recipient_id=?1 AND a.status='ACTIVE' AND ${unblocked('?1', 'n.actor_id')}
 AND (n.post_id IS NULL OR EXISTS(SELECT 1 FROM posts p JOIN profiles u ON u.user_id=p.author_id WHERE p.post_id=n.post_id AND ${visiblePost()}))`;

export async function socialRoutes(
  request: Request,
  env: Bindings,
  principal: Principal,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method,
    me = principal.userId;
  if (path === '/v1/users' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query || query.length > 80) return json({ users: [], nextCursor: null });
    const after = url.searchParams.get('after') ?? '';
    if (after && !validID(after)) fail(400, 'INVALID_CURSOR', '一覧を更新してください。');
    const rows = await env.HOME.prepare(
      `SELECT ${userFields} FROM profiles u WHERE ${visibleUser} AND u.user_id!=?1 AND u.user_id>?3 AND u.display_name LIKE ?2 ESCAPE '\\' ORDER BY u.user_id LIMIT 21`,
    )
      .bind(me, '%' + query.replace(/[\\%_]/g, '\\$&') + '%', after)
      .all();
    return json({
      users: rows.results.slice(0, 20),
      nextCursor: rows.results.length > 20 ? rows.results[19].userId : null,
    });
  }
  if (path === '/v1/follow-requests' && method === 'GET') {
    const c = cursor(url);
    const rows = await env.HOME.prepare(
      `SELECT ${userFields},f.updated_at AS created_at FROM followers f JOIN profiles u ON u.user_id=f.follower_id WHERE f.target_id=?1 AND f.state='PENDING' AND ${visibleUser} AND (f.updated_at<?2 OR f.updated_at=?2 AND f.follower_id<?3) ORDER BY f.updated_at DESC,f.follower_id DESC LIMIT 21`,
    )
      .bind(me, c.at, c.id)
      .all();
    return json(page(rows.results, 'userId'));
  }
  const profile =
    /^\/v1\/users\/([A-Za-z0-9_-]{1,128})(?:\/(follow|followers|following|posts))?$/.exec(path);
  if (profile) {
    const target = profile[1],
      action = profile[2],
      p = await user(env, me, target);
    if (!action && method === 'GET') {
      const counts = await env.HOME.prepare(
        `SELECT
        (SELECT COUNT(*) FROM followers f JOIN profiles u ON u.user_id=f.follower_id WHERE f.target_id=?2 AND f.state='APPROVED' AND ${visibleUser}) AS followers,
        (SELECT COUNT(*) FROM followers f JOIN profiles u ON u.user_id=f.target_id WHERE f.follower_id=?2 AND f.state='APPROVED' AND ${visibleUser}) AS following,
        (SELECT COUNT(*) FROM posts p JOIN profiles u ON u.user_id=p.author_id WHERE p.author_id=?2 AND ${visiblePost()}) AS posts`,
      )
        .bind(me, target)
        .first();
      return json({ profile: { ...p, isPrivate: !!p.isPrivate, ...counts } });
    }
    if (action === 'follow' && (method === 'PUT' || method === 'DELETE')) {
      if (me === target) fail(400, 'SELF_TARGET', '自分自身はフォローできません。');
      if (method === 'DELETE') {
        await env.HOME.prepare(
          `UPDATE followers SET state='REMOVED',revision=revision+1,updated_at=?3 WHERE target_id=?2 AND follower_id=?1 AND state!='REMOVED'`,
        )
          .bind(me, target, new Date().toISOString())
          .run();
      } else {
        await env.HOME.prepare(
          `INSERT INTO followers(target_id,follower_id,state,revision,updated_at)
          SELECT u.user_id,?1,CASE u.is_private WHEN 1 THEN 'PENDING' ELSE 'APPROVED' END,1,?3 FROM profiles u WHERE u.user_id=?2 AND ${visibleUser}
          AND EXISTS(SELECT 1 FROM profiles WHERE user_id=?1 AND status='ACTIVE')
          ON CONFLICT(target_id,follower_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,revision=followers.revision+1 WHERE followers.state='REMOVED'`,
        )
          .bind(me, target, new Date().toISOString())
          .run();
      }
      return json({ profile: await user(env, me, target) });
    }
    if ((action === 'followers' || action === 'following') && method === 'GET') {
      if (p.isPrivate && me !== target && p.relationship !== 'APPROVED')
        fail(403, 'FOLLOW_REQUIRED', 'フォロー申請の承認後に確認できます。');
      const c = cursor(url),
        incoming = action === 'followers';
      const rows = await env.HOME.prepare(
        `SELECT ${userFields},f.updated_at AS created_at FROM followers f JOIN profiles u ON u.user_id=f.${incoming ? 'follower_id' : 'target_id'} WHERE f.${incoming ? 'target_id' : 'follower_id'}=?2 AND f.state='APPROVED' AND ${visibleUser} AND (f.updated_at<?3 OR f.updated_at=?3 AND u.user_id<?4) ORDER BY f.updated_at DESC,u.user_id DESC LIMIT 21`,
      )
        .bind(me, target, c.at, c.id)
        .all();
      return json(page(rows.results, 'userId'));
    }
    if (action === 'posts' && method === 'GET') return postList(env, me, url, target);
  }
  const follower = /^\/v1\/(follow-requests|followers)\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (follower && (method === 'PUT' || method === 'DELETE')) {
    if (method === 'PUT' && follower[1] !== 'follow-requests')
      fail(405, 'METHOD_NOT_ALLOWED', '申請から承認してください。');
    await user(env, me, follower[2]);
    await env.HOME.prepare(
      `UPDATE followers SET state=?3,revision=revision+1,updated_at=?4 WHERE target_id=?1 AND follower_id=?2 AND state${method === 'PUT' ? "='PENDING'" : "!='REMOVED'"} AND ${unblocked('?1', '?2')}
      AND (SELECT COUNT(*) FROM profiles WHERE user_id IN (?1,?2) AND status='ACTIVE')=2`,
    )
      .bind(me, follower[2], method === 'PUT' ? 'APPROVED' : 'REMOVED', new Date().toISOString())
      .run();
    return json({ updated: true });
  }
  if (path === '/v1/saved-posts' && method === 'GET') return postList(env, me, url);
  const interaction = /^\/v1\/posts\/([A-Za-z0-9_-]{1,128})\/(like|save|comments|social)$/.exec(
    path,
  );
  if (interaction) {
    const post = interaction[1],
      action = interaction[2];
    await readPost(env, post, me);
    if ((action === 'like' || action === 'save') && (method === 'PUT' || method === 'DELETE')) {
      const table = action === 'like' ? 'post_likes' : 'post_saves';
      if (method === 'DELETE')
        await env.HOME.prepare(`DELETE FROM ${table} WHERE post_id=? AND user_id=?`)
          .bind(post, me)
          .run();
      else
        await env.HOME.prepare(
          `INSERT OR IGNORE INTO ${table}(post_id,user_id,created_at) SELECT p.post_id,?1,?3 FROM posts p JOIN profiles u ON u.user_id=p.author_id WHERE p.post_id=?2 AND ${visiblePost()} AND EXISTS(SELECT 1 FROM profiles WHERE user_id=?1 AND status='ACTIVE')`,
        )
          .bind(me, post, new Date().toISOString())
          .run();
      return json({ social: (await socialPosts(env, [{ post_id: post }], me))[0] });
    }
    if (action === 'social' && method === 'GET')
      return json({ social: (await socialPosts(env, [{ post_id: post }], me))[0] });
    if (action === 'comments' && method === 'GET') {
      const c = cursor(url);
      const rows = await env.HOME.prepare(
        `SELECT c.*,u.display_name FROM post_comments c JOIN profiles u ON u.user_id=c.user_id WHERE c.post_id=?2 AND ${visibleUser} AND EXISTS(SELECT 1 FROM posts p JOIN profiles u ON u.user_id=p.author_id WHERE p.post_id=?2 AND ${visiblePost()}) AND (c.created_at<?3 OR c.created_at=?3 AND c.comment_id<?4) ORDER BY c.created_at DESC,c.comment_id DESC LIMIT 21`,
      )
        .bind(me, post, c.at, c.id)
        .all();
      return json(page(rows.results, 'comment_id'));
    }
    if (action === 'comments' && method === 'POST') {
      const data = await bodyJSON(request, 12_288),
        body = typeof data.body === 'string' ? data.body.trim() : '';
      if (!validID(data.commentId) || !body || body.length > 2000 || countGraphemes(body) > 500)
        fail(400, 'INVALID_COMMENT', 'コメントは1〜500文字で入力してください。');
      const existing = await env.HOME.prepare('SELECT * FROM post_comments WHERE comment_id=?')
        .bind(data.commentId)
        .first();
      if (existing) {
        if (existing.post_id !== post || existing.user_id !== me || existing.body !== body)
          fail(409, 'COMMENT_CONFLICT', 'コメントを更新して再試行してください。');
        return json({ comment: existing });
      }
      const now = new Date().toISOString();
      const result = await env.HOME.prepare(
        `INSERT OR IGNORE INTO post_comments(comment_id,post_id,user_id,body,created_at)
        SELECT ?3,p.post_id,?1,?4,?5 FROM posts p JOIN profiles u ON u.user_id=p.author_id WHERE p.post_id=?2 AND ${visiblePost()}
        AND EXISTS(SELECT 1 FROM profiles WHERE user_id=?1 AND status='ACTIVE') AND (SELECT COUNT(*) FROM post_comments WHERE user_id=?1 AND created_at>=?6)<10`,
      )
        .bind(me, post, data.commentId, body, now, new Date(Date.now() - 60_000).toISOString())
        .run();
      if (!result.meta.changes)
        fail(429, 'COMMENT_LIMIT', '少し待ってから投稿を確認し、再試行してください。');
      return json({ comment: { comment_id: data.commentId, body, created_at: now } }, 201);
    }
  }
  const comment = /^\/v1\/comments\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (comment && method === 'DELETE') {
    const row = await env.HOME.prepare(
      'SELECT c.post_id,c.user_id,p.author_id FROM post_comments c JOIN posts p ON p.post_id=c.post_id WHERE c.comment_id=?',
    )
      .bind(comment[1])
      .first<{ post_id: string; user_id: string; author_id: string }>();
    if (row && row.user_id !== me && row.author_id !== me)
      fail(403, 'NOT_OWNER', 'このコメントは削除できません。');
    await env.HOME.prepare(
      'DELETE FROM post_comments WHERE comment_id=? AND (user_id=? OR post_id IN (SELECT post_id FROM posts WHERE author_id=?))',
    )
      .bind(comment[1], me, me)
      .run();
    return json({ deleted: true });
  }
  if (path === '/v1/notifications' && method === 'GET') {
    const c = cursor(url);
    const rows = await env.HOME.prepare(
      `SELECT n.*,a.display_name FROM social_notifications n JOIN profiles a ON a.user_id=n.actor_id WHERE ${notificationVisible} AND (n.created_at<?2 OR n.created_at=?2 AND n.notification_id<?3) ORDER BY n.created_at DESC,n.notification_id DESC LIMIT 21`,
    )
      .bind(me, c.at, c.id)
      .all();
    const count = await env.HOME.prepare(
      `SELECT COUNT(*) AS unread FROM social_notifications n JOIN profiles a ON a.user_id=n.actor_id WHERE ${notificationVisible} AND n.read_at IS NULL`,
    )
      .bind(me)
      .first();
    return json({ ...page(rows.results, 'notification_id'), ...count });
  }
  if (path === '/v1/notifications/read' && method === 'POST') {
    const data = await bodyJSON(request, 16_384);
    if (
      !Array.isArray(data.ids) ||
      data.ids.length > 100 ||
      data.ids.some((v: unknown) => typeof v !== 'string' || v.length > 400)
    )
      fail(400, 'INVALID_NOTIFICATIONS', '通知を選び直してください。');
    if (data.ids.length)
      await env.HOME.prepare(
        `UPDATE social_notifications SET read_at=COALESCE(read_at,?) WHERE recipient_id=? AND notification_id IN (${data.ids.map(() => '?').join(',')})`,
      )
        .bind(new Date().toISOString(), me, ...data.ids)
        .run();
    return json({ read: true });
  }
}
async function postList(env: Bindings, me: string, url: URL, author?: string) {
  const c = cursor(url);
  const rows = await env.HOME.prepare(
    `SELECT p.*,u.display_name FROM posts p JOIN profiles u ON u.user_id=p.author_id WHERE ${visiblePost()} AND ${author ? 'p.author_id=?4' : 'EXISTS(SELECT 1 FROM post_saves s WHERE s.post_id=p.post_id AND s.user_id=?1)'} AND (p.created_at<?2 OR p.created_at=?2 AND p.post_id<?3) ORDER BY p.created_at DESC,p.post_id DESC LIMIT 21`,
  )
    .bind(me, c.at, c.id, ...(author ? [author] : []))
    .all<{ post_id: string; created_at: string }>();
  const result = page(rows.results, 'post_id');
  return json({ posts: await socialPosts(env, result.items, me), nextCursor: result.nextCursor });
}
