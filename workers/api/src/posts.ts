import { jwtVerify, SignJWT } from 'jose';
import { canViewPost, countGraphemes, type Visibility } from '@justtaken/contracts';
import { ApiError, bodyJSON, fail, json, requireValue, unwrap, validID } from './http';
import { originalKey } from './media';
import type { Bindings, Principal, Profile } from './types';
import { socialPosts } from './social';
import { canSharePost } from '@justtaken/contracts/post-share';
export interface PostRow {
  post_id: string;
  author_id: string;
  capture_id: string;
  installation_id: string;
  caption: string;
  visibility: Visibility;
  state: string;
  moderation: string;
  revision: number;
  created_at: string;
  published_at: string | null;
  server_verified_at: string | null;
  display_name: string;
  is_private: number;
  status: string;
}
const selectPost =
  'SELECT p.*,u.display_name,u.is_private,u.status FROM posts p JOIN profiles u ON p.author_id=u.user_id';
export async function readPost(env: Bindings, id: string, viewer: string): Promise<PostRow> {
  const p = await env.HOME.prepare(selectPost + ' WHERE p.post_id=?')
    .bind(id)
    .first<PostRow>();
  if (!p || p.status !== 'ACTIVE') fail(404, 'POST_NOT_FOUND', '投稿が見つかりません。');
  const [block, follower] = await Promise.all([
    env.HOME.prepare(
      'SELECT 1 AS found FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1',
    )
      .bind(viewer, p!.author_id, p!.author_id, viewer)
      .first(),
    env.HOME.prepare(
      "SELECT 1 AS found FROM followers WHERE target_id=? AND follower_id=? AND state='APPROVED'",
    )
      .bind(p!.author_id, viewer)
      .first(),
  ]);
  if (
    !canViewPost({
      isOwner: viewer === p!.author_id,
      accountPrivate: !!p!.is_private,
      approvedFollower: !!follower,
      blocked: !!block,
      postState: p!.state,
      visibility: p!.visibility,
    })
  )
    fail(404, 'POST_NOT_FOUND', '投稿が見つかりません。');
  return p!;
}
export async function publish(env: Bindings, p: PostRow) {
  const capture = unwrap(
    await env.CAPTURE.getByName(p.installation_id).snapshot(p.author_id, p.capture_id),
  );
  if (capture.state !== 'VERIFIED') return p;
  const moderation = await env.HOME.prepare(
    'SELECT decision FROM moderation_decisions WHERE capture_id=?',
  )
    .bind(p.capture_id)
    .first<{ decision: string }>();
  if (!moderation) return p;
  const allowed = moderation.decision === 'ALLOWED';
  await env.HOME.prepare(
    "UPDATE posts SET state=?,moderation=?,server_verified_at=?,published_at=COALESCE(published_at,?),revision=revision+1 WHERE post_id=? AND state IN ('PROCESSING','READY') AND EXISTS(SELECT 1 FROM profiles WHERE user_id=posts.author_id AND status='ACTIVE' AND (is_private=0 OR posts.visibility!='public'))",
  )
    .bind(
      allowed ? 'PUBLISHED' : 'HIDDEN',
      moderation.decision,
      capture.verifiedAt!,
      new Date().toISOString(),
      p.post_id,
    )
    .run();
  return (await env.HOME.prepare(selectPost + ' WHERE p.post_id=?')
    .bind(p.post_id)
    .first<PostRow>())!;
}
export async function postRoutes(
  request: Request,
  env: Bindings,
  principal: Principal,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === '/v1/posts' && method === 'POST') {
    const data = await bodyJSON(request);
    if (
      !validID(data.installationId) ||
      !validID(data.captureId) ||
      typeof data.caption !== 'string' ||
      countGraphemes(data.caption) > 500 ||
      !['private', 'followers', 'public'].includes(data.visibility)
    )
      fail(400, 'INVALID_POST', '投稿内容を確認してください。');
    const profile = await env.HOME.prepare('SELECT * FROM profiles WHERE user_id=?')
      .bind(principal.userId)
      .first<Profile>();
    if (profile!.is_private && data.visibility === 'public')
      fail(409, 'PRIVATE_ACCOUNT', '非公開アカウントでは全体公開にできません。');
    const capture = unwrap(
      await env.CAPTURE.getByName(data.installationId).snapshot(principal.userId, data.captureId),
    );
    if (!['COMMITTED', 'UPLOADING', 'VERIFIED'].includes(capture.state))
      fail(409, 'CAPTURE_NOT_COMMITTED', '撮影記録を確定してから投稿してください。');
    const existing = await env.HOME.prepare(selectPost + ' WHERE p.capture_id=?')
      .bind(data.captureId)
      .first<PostRow>();
    if (existing) {
      if (
        existing.author_id !== principal.userId ||
        existing.caption !== data.caption ||
        existing.visibility !== data.visibility ||
        existing.state === 'DELETED'
      )
        fail(409, 'POST_CONFLICT', 'この写真にはすでに投稿があります。');
      return json({ post: await publish(env, existing) });
    }
    const id = crypto.randomUUID();
    await env.HOME.prepare(
      "INSERT OR IGNORE INTO posts(post_id,author_id,bucket_id,capture_id,installation_id,caption,visibility,created_at) SELECT ?,user_id,bucket_id,?,?,?,?,? FROM profiles WHERE user_id=? AND status='ACTIVE'",
    )
      .bind(
        id,
        data.captureId,
        data.installationId,
        data.caption,
        data.visibility,
        new Date().toISOString(),
        principal.userId,
      )
      .run();
    const inserted = await env.HOME.prepare(selectPost + ' WHERE p.capture_id=?')
      .bind(data.captureId)
      .first<PostRow>();
    if (!inserted || inserted.caption !== data.caption || inserted.visibility !== data.visibility)
      fail(409, 'POST_CONFLICT', '別の投稿内容が先に保存されました。');
    return json({ post: await publish(env, inserted!) }, 201);
  }
  if (path === '/v1/feed' && method === 'GET') {
    let cursor: { at: string; id: string } | undefined;
    if (url.searchParams.has('cursor')) {
      try {
        cursor = JSON.parse(Buffer.from(url.searchParams.get('cursor')!, 'base64url').toString());
        if (!cursor || typeof cursor.at !== 'string' || !validID(cursor.id)) throw new Error();
      } catch {
        fail(400, 'INVALID_CURSOR', '一覧を更新してください。');
      }
    }
    const scope = url.searchParams.get('scope');
    const followsAuthor =
      "EXISTS(SELECT 1 FROM followers f WHERE f.target_id=p.author_id AND f.follower_id=?1 AND f.state='APPROVED')";
    const publicPost = "(p.visibility='public' AND u.is_private=0)";
    let visibility = `p.author_id=?1 OR (p.state='PUBLISHED' AND p.visibility!='private' AND (${publicPost} OR ${followsAuthor}))`;
    if (scope === 'mine') visibility = 'p.author_id=?1';
    if (scope === 'following')
      visibility = `p.author_id=?1 OR (p.state='PUBLISHED' AND p.visibility!='private' AND ${followsAuthor})`;
    if (scope === 'recommended')
      visibility = `p.author_id!=?1 AND p.state='PUBLISHED' AND p.moderation='ALLOWED' AND ${publicPost} AND NOT ${followsAuthor}`;
    const results = await env.HOME.prepare(
      `${selectPost} WHERE u.status='ACTIVE' AND p.state NOT IN ('DELETED','HIDDEN') AND (${visibility})
       AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=?1 AND b.blocked_id=p.author_id) OR (b.blocker_id=p.author_id AND b.blocked_id=?1))
       AND (p.created_at<?2 OR (p.created_at=?2 AND p.post_id<?3)) ORDER BY p.created_at DESC,p.post_id DESC LIMIT 21`,
    )
      .bind(principal.userId, cursor?.at ?? '9999', cursor?.id ?? '~')
      .all<PostRow>();
    const items = results.results.slice(0, 20),
      last = items.at(-1);
    return json({
      ...(scope === 'recommended' ? { scope } : {}),
      posts: await socialPosts(env, items, principal.userId),
      nextCursor:
        results.results.length > 20 && last
          ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.post_id })).toString(
              'base64url',
            )
          : null,
    });
  }
  const match =
    /^\/v1\/posts\/([A-Za-z0-9_-]+)(?:\/(shared|publish|media-grants|record|media\/(original|thumbnail|poster)))?$/.exec(
      path,
    );
  if (!match) return;
  if (match[2] === 'shared' && method !== 'GET') return;
  if (!match[2] && method === 'DELETE') {
    const tombstone = await env.HOME.prepare(
      "SELECT post_id FROM posts WHERE post_id=? AND author_id=? AND state='DELETED'",
    )
      .bind(match[1], principal.userId)
      .first();
    if (tombstone) return json({ deleted: true });
  }
  const p = await readPost(env, match[1], principal.userId);
  if ((!match[2] || match[2] === 'shared') && method === 'GET') {
    if (match[2] === 'shared' && (p.is_private || !canSharePost(p)))
      fail(404, 'POST_NOT_FOUND', '投稿が見つかりません。');
    return json({ post: (await socialPosts(env, [p], principal.userId))[0] });
  }
  if (!match[2] && method === 'DELETE') {
    if (p.author_id !== principal.userId) fail(403, 'NOT_OWNER', 'この投稿は削除できません。');
    const retained = await env.HOME.prepare(
      'SELECT proof_id FROM capture_proofs WHERE capture_id=? AND owner_id=?',
    )
      .bind(p.capture_id, principal.userId)
      .first();
    if (retained) {
      await env.HOME.prepare(
        "UPDATE posts SET state='DELETED',revision=revision+1 WHERE post_id=? AND author_id=? AND state!='DELETED'",
      )
        .bind(p.post_id, principal.userId)
        .run();
    } else {
      unwrap(await env.CAPTURE.getByName(p.installation_id).cancel(principal.userId, p.capture_id));
    }
    return json({ deleted: true });
  }
  if (match[2] === 'publish' && method === 'POST') {
    if (p.author_id !== principal.userId) fail(403, 'NOT_OWNER', 'この投稿は変更できません。');
    return json({ post: await publish(env, p) });
  }
  const capture = unwrap(
    await env.CAPTURE.getByName(p.installation_id).snapshot(p.author_id, p.capture_id),
  );
  if (capture.state !== 'VERIFIED') fail(409, 'VERIFICATION_PENDING', '撮影記録を確認しています。');
  if (match[2] === 'record' && method === 'GET')
    return json({
      state: capture.state,
      manifest: capture.manifest,
      verifiedAt: capture.verifiedAt,
      receipt: capture.receipt,
      notice: '写っている内容の真偽を保証するものではありません。',
    });
  if (match[2] === 'media-grants' && method === 'POST') {
    requireValue(env.MEDIA_SECRET && env.MEDIA_SECRET.length >= 32);
    const grant = await new SignJWT({ postId: p.post_id, revision: p.revision })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('justtaken-media')
      .setAudience('justtaken-media')
      .setSubject(principal.userId)
      .setIssuedAt()
      .setExpirationTime('120s')
      .sign(new TextEncoder().encode(env.MEDIA_SECRET));
    return json({
      expiresIn: 120,
      original: `/v1/posts/${p.post_id}/media/original?grant=${grant}`,
      kind: capture.manifest!.kind,
      originalFormat: {
        mime: capture.manifest!.assets[0].mime,
        hasGainMap: capture.manifest!.assets[0].hasGainMap ?? false,
        preservation: capture.manifest!.assets[0].preservation ?? null,
      },
      preview: `/v1/posts/${p.post_id}/media/${capture.manifest!.kind === 'video' ? 'poster' : 'thumbnail'}?grant=${grant}`,
      thumbnail: `/v1/posts/${p.post_id}/media/${capture.manifest!.kind === 'video' ? 'poster' : 'thumbnail'}?grant=${grant}`,
    });
  }
  if (match[3] && ['GET', 'HEAD'].includes(method)) {
    requireValue(env.MEDIA_SECRET);
    try {
      const { payload } = await jwtVerify(
        url.searchParams.get('grant') ?? '',
        new TextEncoder().encode(env.MEDIA_SECRET),
        {
          algorithms: ['HS256'],
          issuer: 'justtaken-media',
          audience: 'justtaken-media',
          subject: principal.userId,
          requiredClaims: ['exp', 'iat', 'sub'],
        },
      );
      if (payload.postId !== p.post_id || payload.revision !== p.revision) throw new Error();
    } catch {
      fail(403, 'MEDIA_GRANT_EXPIRED', '写真の表示を更新してください。');
    }
    const asset = capture.manifest!.assets.find((a) => a.id === match[3])!;
    if (!asset) fail(404, 'MEDIA_NOT_FOUND', 'メディアが見つかりません。');
    const etag = '"' + asset.sha256 + '"';
    let range: ReturnType<typeof parseRange>;
    try {
      range = parseRange(
        request.headers.has('if-range') && request.headers.get('if-range') !== etag
          ? null
          : request.headers.get('range'),
        asset.bytes,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 416)
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${asset.bytes}`,
            'Cache-Control': 'private, no-store',
            'Accept-Ranges': 'bytes',
          },
        });
      throw error;
    }
    const headers = new Headers({
      'Content-Type': asset.mime,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Content-Length': String(range?.length ?? asset.bytes),
    });
    if (range)
      headers.set(
        'Content-Range',
        `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.bytes}`,
      );
    const object = await env.ORIGINALS.get(
      originalKey(p.installation_id, p.capture_id, asset),
      range ? { range } : undefined,
    );
    if (!object) fail(404, 'MEDIA_NOT_FOUND', '写真が見つかりません。');
    if (method === 'HEAD') {
      await object!.body.cancel();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    return new Response(object!.body, { status: range ? 206 : 200, headers });
  }
}
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | undefined {
  if (!header) return;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) fail(416, 'INVALID_RANGE', '指定範囲を読み込めません。');
  let start: number, end: number;
  if (!m![1]) {
    const suffix = Number(m![2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1)
      fail(416, 'INVALID_RANGE', '指定範囲を読み込めません。');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m![1]);
    end = m![2] ? Math.min(Number(m![2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    fail(416, 'INVALID_RANGE', '指定範囲を読み込めません。');
  return { offset: start, length: end - start + 1 };
}
