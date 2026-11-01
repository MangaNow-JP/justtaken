import { countGraphemes, profileBioMaxGraphemes } from '@justtaken/contracts/text';
import { requireCommunityConsent } from './community';
import { bodyJSON, fail, json } from './http';
import type { Bindings, Principal } from './types';
export { deletionStatus } from './account-deletion';
export async function accountRoutes(request: Request, env: Bindings, principal: Principal) {
  if (new URL(request.url).pathname !== '/v1/me') return;
  if (request.method === 'POST') {
    const data = await bodyJSON(request, 16_384);
    if (
      typeof data.displayName !== 'string' ||
      !data.displayName.trim() ||
      Array.from(data.displayName.trim()).length > 30 ||
      typeof data.isPrivate !== 'boolean'
    )
      fail(400, 'INVALID_PROFILE', '表示名は1〜30文字で入力してください。');
    if (data.bio !== undefined && typeof data.bio !== 'string')
      fail(400, 'INVALID_BIO', '自己紹介は文字で入力してください。');
    const bio: string | undefined = data.bio?.trim();
    if (bio && countGraphemes(bio) > profileBioMaxGraphemes)
      fail(400, 'INVALID_BIO', `自己紹介は${profileBioMaxGraphemes}文字以内で入力してください。`);
    if (bio) await requireCommunityConsent(env, principal.userId);
    await env.HOME.batch([
      env.HOME.prepare(
        "UPDATE profiles SET display_name=?,is_private=?,bio=COALESCE(?,bio),acl_revision=acl_revision+1 WHERE user_id=? AND status='ACTIVE'",
      ).bind(data.displayName.trim(), data.isPrivate ? 1 : 0, bio ?? null, principal.userId),
      // Making an account private immediately retires all former public grants and posts.
      env.HOME.prepare(
        "UPDATE posts SET visibility='private',revision=revision+1 WHERE author_id=? AND visibility='public' AND ?=1",
      ).bind(principal.userId, data.isPrivate ? 1 : 0),
    ]);
    return json({ updated: true });
  }
  return;
}
