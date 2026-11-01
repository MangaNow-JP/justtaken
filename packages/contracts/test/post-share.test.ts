import assert from 'node:assert/strict';
import test from 'node:test';
import { canSharePost, postShareUrl, sharedPostId } from '../src/post-share';

const origin = 'https://justtaken.app';
const id = '502e98dd-e777-4182-8bd5-b55f6003f476';

test('only approved published public posts offer external sharing', () => {
  const post = { state: 'PUBLISHED', visibility: 'public', moderation: 'ALLOWED' };
  assert.ok(canSharePost(post));
  for (const change of [
    { state: 'HIDDEN' },
    { state: 'DELETED' },
    { state: 'PROCESSING' },
    { visibility: 'private' },
    { visibility: 'followers' },
    { moderation: 'PENDING' },
  ])
    assert.equal(canSharePost({ ...post, ...change }), false);
});

test('a share carries only its post ID and cannot navigate outside the post detail screen', () => {
  const link = postShareUrl(id, origin);
  assert.equal(link, origin + '/public/posts/' + id);
  for (const url of [link, 'justtaken://post/' + id, 'justtaken-dev://post/' + id])
    assert.equal(sharedPostId(url, origin), id);
  for (const url of [
    link + '?token=abc',
    link + '#private',
    link + '/other',
    'https://justtaken.app.evil.invalid/public/posts/' + id,
    'justtaken://auth?code=sensitive',
    'other://post/' + id,
    origin + '/public/posts/%2e%2e',
    'justtaken://post/',
  ])
    assert.equal(sharedPostId(url, origin), undefined);
  assert.throws(() => postShareUrl(id + '?grant=sensitive', origin));
});
