import { bodyJSON, fail, json } from './http';
import type { Bindings, Principal } from './types';
export { deletionStatus } from './account-deletion';
export async function accountRoutes(request: Request, env: Bindings, principal: Principal) {
  if (new URL(request.url).pathname !== '/v1/me') return;
  if (request.method === 'POST') {
    const data = await bodyJSON(request, 1024);
    if (
      typeof data.displayName !== 'string' ||
      !data.displayName.trim() ||
      Array.from(data.displayName.trim()).length > 30 ||
      typeof data.isPrivate !== 'boolean'
    )
      fail(400, 'INVALID_PROFILE', '表示名は1〜30文字で入力してください。');
    await env.HOME.batch([
      env.HOME.prepare(
        "UPDATE profiles SET display_name=?,is_private=?,acl_revision=acl_revision+1 WHERE user_id=? AND status='ACTIVE'",
      ).bind(data.displayName.trim(), data.isPrivate ? 1 : 0, principal.userId),
      // Making an account private immediately retires all former public grants and posts.
      env.HOME.prepare(
        "UPDATE posts SET visibility='private',revision=revision+1 WHERE author_id=? AND visibility='public' AND ?=1",
      ).bind(principal.userId, data.isPrivate ? 1 : 0),
    ]);
    return json({ updated: true });
  }
  return;
}
