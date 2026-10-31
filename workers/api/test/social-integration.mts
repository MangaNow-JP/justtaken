import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'social-test',
        modules: true,
        scriptPath: 'artifacts/test-worker/fixture-worker.js',
        compatibilityDate: '2026-10-25',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          AUTH: { className: 'FixtureAuth', useSQLite: true },
          CAPTURE: { className: 'FixtureCapture', useSQLite: true },
        },
        d1Databases: ['HOME'],
        r2Buckets: ['STAGING', 'ORIGINALS'],
        bindings: {
          ENVIRONMENT: 'development',
          API_ORIGIN: 'http://test',
          MEDIA_SECRET: randomBytes(32).toString('hex'),
        },
      },
    ],
  }),
);
let checks = 0;
function eq(actual: unknown, expected: unknown, message: string) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
async function call(path: string, access: string, method = 'GET', body?: unknown) {
  const res = await mf.dispatchFetch('http://test' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(access ? { Authorization: 'Bearer ' + access } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  return { ...data, status: res.status };
}
try {
  const db = await mf.getD1Database('HOME');
  for (const name of (await readdir('workers/api/migrations/home'))
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    if (name === '0014_comment_reports.sql') {
      await db
        .prepare(
          "INSERT INTO profiles(user_id,bucket_id,display_name,created_at) VALUES('migration-a',0,'migration fixture',?),('migration-b',0,'migration fixture',?)",
        )
        .bind('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        .run();
      await db
        .prepare(
          "INSERT INTO user_reports(report_id,reporter_id,target_user_id,target_kind,target_id,reason,details,created_at) VALUES('migration-report','migration-a','migration-b','user','migration-b','spam','preserved evidence','2026-01-01T00:00:00Z')",
        )
        .run();
    }
    let sql = '',
      trigger = false;
    for (const line of (await readFile('workers/api/migrations/home/' + name, 'utf8')).split(
      '\n',
    )) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      sql += line + ' ';
      if (/^CREATE TRIGGER/.test(sql.trim())) trigger = true;
      if ((!trigger && line.trim().endsWith(';')) || (trigger && line.trim() === 'END;')) {
        await db.prepare(sql).run();
        sql = '';
        trigger = false;
      }
    }
  }
  eq(
    (await db
      .prepare("SELECT details FROM user_reports WHERE report_id='migration-report'")
      .first())!.details,
    'preserved evidence',
    'migration preserves existing reports',
  );
  async function seed(userId: string, isPrivate = 1, display = userId) {
    const sessionId = randomUUID(),
      access = randomBytes(32).toString('base64url');
    eq(
      (
        await call('/__fixture/seed', '', 'POST', {
          userId,
          sessionId,
          installationId: randomUUID(),
          access,
          refresh: randomBytes(32).toString('base64url'),
          publicKey: 'fixture',
        })
      ).status,
      200,
      'seed isolated fixture',
    );
    await db
      .prepare('UPDATE profiles SET is_private=?,display_name=? WHERE user_id=?')
      .bind(isPrivate, display, userId)
      .run();
    return sessionId + '.' + access;
  }
  const alice = await seed('alice'),
    bob = await seed('bob', 0, 'ボブ'),
    eve = await seed('eve'),
    outsider = await seed('outsider'),
    wild = await seed('literal', 0, '100%_real');
  async function post(id: string, author: string, visibility: string) {
    await db
      .prepare(
        "INSERT INTO posts(post_id,author_id,bucket_id,capture_id,installation_id,caption,visibility,state,moderation,created_at) VALUES(?,?,0,?,'fixture','moment',?,'PUBLISHED','ALLOWED',?)",
      )
      .bind(id, author, randomUUID(), visibility, new Date().toISOString())
      .run();
  }
  await post('private-photo', 'alice', 'followers');
  await post('public-photo', 'bob', 'public');
  eq((await call('/v1/users?q=ボブ', '')).status, 401, 'search requires authentication');
  eq(
    (await call('/v1/users?q=%25_', bob)).users.map((x: any) => x.userId),
    ['literal'],
    'LIKE metacharacters are literal',
  );
  eq(
    (await call('/v1/users?q=ボブ', alice)).users.map((x: any) => x.userId),
    ['bob'],
    'search display name',
  );
  eq((await call('/v1/users/alice/follow', alice, 'PUT')).status, 400, 'no self-follow');
  eq(
    (await call('/v1/users/alice/follow', bob, 'PUT')).profile.relationship,
    'PENDING',
    'private account requests approval',
  );
  eq(
    (await call('/v1/users/alice/follow', bob, 'PUT')).profile.relationship,
    'PENDING',
    'idempotent request',
  );
  eq(
    (await call('/v1/follow-requests', alice)).items.map((x: any) => x.userId),
    ['bob'],
    'incoming requests only',
  );
  eq((await call('/v1/notifications', alice)).items.length, 1, 'one request notification');
  eq(
    (await call('/v1/posts/private-photo/like', bob, 'PUT')).status,
    404,
    'pending cannot like private post',
  );
  eq(
    (await call('/v1/users/alice/followers', bob)).status,
    403,
    'pending cannot enumerate private followers',
  );
  eq(
    (await call('/v1/users/alice/posts', bob)).posts.length,
    0,
    'pending cannot view private posts',
  );
  await call('/v1/follow-requests/bob', eve, 'PUT');
  eq(
    (await call('/v1/users/alice', bob)).profile.relationship,
    'PENDING',
    'third party cannot approve somebody else request',
  );
  eq((await call('/v1/follow-requests/bob', alice, 'PUT')).status, 200, 'owner approves');
  eq(
    (await call('/v1/users/alice', bob)).profile.relationship,
    'APPROVED',
    'approved relationship',
  );
  eq(
    (await call('/v1/users/alice/posts', bob)).posts.length,
    1,
    'approved sees private account posts',
  );
  eq(
    (await call('/v1/users/alice/followers', bob)).items[0].userId,
    'bob',
    'approved can see follower list',
  );
  eq((await call('/v1/notifications', bob)).items[0].kind, 'accepted', 'acceptance notification');
  await call('/v1/users/bob/follow', alice, 'PUT');
  eq(
    (await call('/v1/users/bob', alice)).profile.relationship,
    'APPROVED',
    'public accounts approve immediately',
  );
  eq(
    (await call('/v1/feed?scope=following', alice)).posts.length,
    2,
    'following feed includes own and followed',
  );
  eq(
    (await call('/v1/feed?scope=following', eve)).posts.length,
    0,
    'following feed excludes strangers',
  );
  await Promise.all(
    Array.from({ length: 3 }, () => call('/v1/posts/private-photo/like', bob, 'PUT')),
  );
  eq(
    (await call('/v1/posts/private-photo/social', bob)).social.like_count,
    1,
    'concurrent repeated likes are idempotent',
  );
  eq(
    (await call('/v1/feed', bob)).posts.find((p: any) => p.post_id === 'private-photo').liked,
    1,
    'feed contains real interaction state',
  );
  eq((await call('/v1/posts/private-photo/save', bob, 'PUT')).status, 200, 'save accessible post');
  eq((await call('/v1/saved-posts', bob)).posts.length, 1, 'personal saved list');
  eq((await call('/v1/saved-posts', alice)).posts.length, 0, 'saves are not shared');
  const commentId = randomUUID();
  eq(
    (
      await call('/v1/posts/private-photo/comments', bob, 'POST', {
        commentId,
        body: 'いい写真ですね。',
      })
    ).status,
    201,
    'create comment',
  );
  eq(
    (
      await call('/v1/posts/private-photo/comments', bob, 'POST', {
        commentId,
        body: 'いい写真ですね。',
      })
    ).status,
    200,
    'retry does not duplicate comment',
  );
  eq(
    (await call('/v1/posts/private-photo/comments', bob, 'POST', { commentId, body: 'changed' }))
      .status,
    409,
    'idempotency mismatch rejected',
  );
  eq(
    (await call('/v1/posts/private-photo/comments', alice)).items[0].body,
    'いい写真ですね。',
    'read comment',
  );
  eq(
    (await call('/v1/posts/private-photo/comments', eve)).status,
    404,
    'comments respect post access',
  );
  eq(
    (await call(`/v1/comments/${commentId}`, eve, 'DELETE')).status,
    403,
    'only author or post owner deletes',
  );
  eq(
    (
      await call('/v1/reports', alice, 'POST', {
        userId: 'bob',
        commentId,
        reason: 'harassment',
        details: 'review this comment',
      })
    ).status,
    201,
    'comment report reaches existing moderation queue',
  );
  eq(
    (await call('/v1/reports', eve, 'POST', { userId: 'bob', commentId, reason: 'harassment' }))
      .status,
    404,
    'cannot report inaccessible comment',
  );
  eq(
    (await call('/v1/reports', alice, 'POST', { userId: 'eve', commentId, reason: 'harassment' }))
      .status,
    404,
    'cannot report comment as another author',
  );
  eq(
    (
      await call('/v1/posts/private-photo/comments', bob, 'POST', {
        commentId: randomUUID(),
        body: ' ',
      })
    ).status,
    400,
    'empty rejected',
  );
  eq(
    (
      await call('/v1/posts/private-photo/comments', bob, 'POST', {
        commentId: randomUUID(),
        body: '字'.repeat(501),
      })
    ).status,
    400,
    'long comment rejected',
  );
  const inbox = await call('/v1/notifications', alice);
  eq(inbox.unread, 3, 'follow, like, comment notifications');
  await call('/v1/notifications/read', eve, 'POST', {
    ids: inbox.items.map((n: any) => n.notification_id),
  });
  eq(
    (await call('/v1/notifications', alice)).unread,
    3,
    'cannot mark other account notifications read',
  );
  await call('/v1/notifications/read', alice, 'POST', {
    ids: inbox.items.map((n: any) => n.notification_id),
  });
  eq((await call('/v1/notifications', alice)).unread, 0, 'mark received notifications read');
  eq(
    (await call(`/v1/comments/${commentId}`, alice, 'DELETE')).status,
    200,
    'post owner can moderate comments',
  );
  eq(
    (await db
      .prepare('SELECT details FROM user_reports WHERE target_id=?')
      .bind(commentId)
      .first())!.details.includes('いい写真ですね。'),
    true,
    'report retains server-read evidence after deletion',
  );
  eq(
    (await call('/v1/posts/private-photo/social', bob)).social.comment_count,
    0,
    'delete updates count',
  );
  eq(
    (await call('/v1/notifications', alice)).items.some((n: any) => n.kind === 'comment'),
    false,
    'deleted comment notification removed',
  );
  await call('/v1/followers/bob', alice, 'DELETE');
  eq(
    (await call('/v1/posts/private-photo/social', bob)).status,
    404,
    'removed follower loses access',
  );
  eq((await call('/v1/saved-posts', bob)).posts.length, 0, 'saved posts recheck permissions');
  eq((await call('/v1/users/alice', bob)).profile.relationship, 'REMOVED', 'follower removed');
  await call('/v1/users/alice/follow', bob, 'PUT');
  await call('/v1/follow-requests/bob', alice, 'DELETE');
  eq((await call('/v1/follow-requests', alice)).items.length, 0, 'reject incoming request');
  await call('/v1/users/alice/follow', bob, 'PUT');
  await call('/v1/users/alice/follow', bob, 'DELETE');
  eq((await call('/v1/follow-requests', alice)).items.length, 0, 'cancel outgoing request');
  await call('/v1/posts/public-photo/like', alice, 'PUT');
  await call('/v1/blocks/bob', alice, 'PUT');
  eq((await call('/v1/users/bob', alice)).status, 404, 'blocked profile hidden');
  eq((await call('/v1/users/alice/follow', bob, 'PUT')).status, 404, 'cannot follow blocker');
  eq((await call('/v1/users?q=ボブ', alice)).users.length, 0, 'blocked user hidden from search');
  eq((await call('/v1/notifications', alice)).items.length, 0, 'blocked notifications removed');
  eq(
    (await call('/v1/notifications', bob)).items.length,
    0,
    'blocked notifications removed both ways',
  );
  await call('/v1/blocks/bob', alice, 'DELETE');
  eq(
    (await call('/v1/users/bob', alice)).profile.relationship,
    'REMOVED',
    'unblock does not restore follows',
  );
  await db.prepare("UPDATE profiles SET status='SUSPENDED' WHERE user_id='literal'").run();
  eq((await call('/v1/users?q=100', alice)).users.length, 0, 'suspended account excluded');
  await db.prepare("DELETE FROM user_consents WHERE user_id='outsider'").run();
  eq(
    (await call('/v1/users/bob/follow', outsider, 'PUT')).status,
    403,
    'social write requires consent',
  );
  eq(
    (await call('/v1/posts/public-photo/like', outsider, 'PUT')).status,
    403,
    'like requires consent',
  );
  eq(
    (await call('/v1/posts/public-photo/save', outsider, 'PUT')).status,
    403,
    'save requires consent',
  );
  // Pagination with tied timestamps, including the boundary cursor.
  for (let i = 0; i < 23; i++)
    await db
      .prepare('INSERT INTO post_comments VALUES(?,?,?,?,?)')
      .bind(
        'paged-' + String(i).padStart(2, '0'),
        'public-photo',
        'eve',
        'comment',
        '2026-01-01T00:00:00Z',
      )
      .run();
  const first = await call('/v1/posts/public-photo/comments', alice);
  eq(first.items.length, 20, 'comment page bounded');
  const second = await call('/v1/posts/public-photo/comments?cursor=' + first.nextCursor, alice);
  eq(second.items.length, 3, 'stable comment cursor');
  eq(
    new Set([...first.items, ...second.items].map((c) => c.comment_id)).size,
    23,
    'no skipped or repeated boundary',
  );
  eq(
    (await call('/v1/notifications?cursor=garbage', alice)).status,
    400,
    'malformed cursor rejected',
  );
  eq(
    (
      await call('/v1/posts/public-photo/comments', eve, 'POST', {
        commentId: randomUUID(),
        body: 'still allowed',
      })
    ).status,
    201,
    'old comments do not consume current rate limit',
  );
  for (let i = 0; i < 9; i++)
    await call('/v1/posts/public-photo/comments', eve, 'POST', {
      commentId: randomUUID(),
      body: 'rate test',
    });
  eq(
    (
      await call('/v1/posts/public-photo/comments', eve, 'POST', {
        commentId: randomUUID(),
        body: 'rate test',
      })
    ).status,
    429,
    'per-user comment rate limit',
  );
  await db.prepare("UPDATE posts SET state='DELETED' WHERE post_id='public-photo'").run();
  eq(
    (await db.prepare("SELECT COUNT(*) n FROM post_comments WHERE post_id='public-photo'").first())!
      .n,
    0,
    'soft post deletion erases comments',
  );
  eq((await call('/v1/notifications', bob)).items.length, 0, 'deleted post notifications gone');
  console.log(`Social integration: ${checks} checks passed.`);
} finally {
  await mf.dispose();
}
