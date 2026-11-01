const postIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function canSharePost(post: { state: string; visibility: string; moderation: string }) {
  return (
    post.state === 'PUBLISHED' && post.visibility === 'public' && post.moderation === 'ALLOWED'
  );
}

export function postShareUrl(postId: string, origin: string) {
  if (!postIdPattern.test(postId)) throw new Error('投稿のリンクを作成できません。');
  return new URL('/public/posts/' + postId, origin).href;
}

export function sharedPostId(url: string, origin: string): string | undefined {
  for (const prefix of [origin + '/public/posts/', 'justtaken://post/', 'justtaken-dev://post/']) {
    if (!url.startsWith(prefix)) continue;
    const id = url.slice(prefix.length);
    if (postIdPattern.test(id)) return id;
  }
}
