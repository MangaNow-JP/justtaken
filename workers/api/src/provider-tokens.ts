import { CompactEncrypt, compactDecrypt, importPKCS8, SignJWT } from 'jose';
import { fail, requireValue } from './http';
import { verifyIdentity } from './identity';
import type { Bindings } from './types';

export function appleConfigured(env: Bindings): boolean {
  return !!(
    env.APPLE_AUDIENCE &&
    env.APPLE_TEAM_ID &&
    env.APPLE_KEY_ID &&
    env.APPLE_PRIVATE_KEY &&
    env.PROVIDER_TOKEN_KEY
  );
}
function tokenKey(env: Bindings) {
  requireValue(env.PROVIDER_TOKEN_KEY);
  const key = Buffer.from(env.PROVIDER_TOKEN_KEY!, 'base64url');
  requireValue(key.byteLength === 32);
  return key;
}
export async function encryptProviderToken(env: Bindings, user: string, token: string) {
  return new CompactEncrypt(new TextEncoder().encode(token))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', sub: user })
    .encrypt(tokenKey(env));
}
export async function decryptProviderToken(env: Bindings, user: string, value: string) {
  const result = await compactDecrypt(value, tokenKey(env));
  if (result.protectedHeader.sub !== user) throw new Error('Provider token binding mismatch');
  return new TextDecoder().decode(result.plaintext);
}
async function appleSecret(env: Bindings) {
  requireValue(appleConfigured(env));
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setSubject(env.APPLE_AUDIENCE!)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(await importPKCS8(env.APPLE_PRIVATE_KEY!, 'ES256'));
}
export async function exchangeAppleCode(
  env: Bindings,
  code: string,
  nonce: string,
  subject: string,
) {
  if (!code || code.length > 4096)
    fail(400, 'APPLE_CODE_REQUIRED', 'Appleで再ログインしてください。');
  const response = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.APPLE_AUDIENCE!,
      client_secret: await appleSecret(env),
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) {
    const error = await response.json<{ error?: string }>().catch(() => ({}) as { error?: string });
    const reason = [
      'invalid_client',
      'invalid_grant',
      'invalid_request',
      'unauthorized_client',
    ].includes(error.error ?? '')
      ? error.error
      : 'other';
    console.warn(JSON.stringify({ event: 'apple_code_rejected', status: response.status, reason }));
    fail(401, 'APPLE_LOGIN_FAILED', 'Appleで再ログインしてください。');
  }
  const data = await response.json<{ id_token?: string; refresh_token?: string }>();
  if (
    !data.id_token ||
    !data.refresh_token ||
    (await verifyIdentity('apple', data.id_token, nonce, env)) !== subject
  )
    fail(401, 'INVALID_IDENTITY', 'Appleの認証情報が一致しません。');
  return data.refresh_token!;
}
export async function storeProviderToken(
  env: Bindings,
  user: string,
  provider: 'apple' | 'google',
  value: string,
) {
  const encrypted = await encryptProviderToken(env, user, value);
  const result = await env.HOME.prepare(
    `INSERT INTO provider_credentials(user_id,provider,token_ciphertext,updated_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='ACTIVE')
    ON CONFLICT(user_id) DO UPDATE SET token_ciphertext=excluded.token_ciphertext,updated_at=excluded.updated_at`,
  )
    .bind(user, provider, encrypted, Date.now(), user)
    .run();
  if (!result.meta.changes) fail(403, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
}
export async function revokeProviderToken(
  env: Bindings,
  user: string,
  provider: string,
  encrypted: string,
) {
  const token = await decryptProviderToken(env, user, encrypted);
  const apple = provider === 'apple';
  const body = apple
    ? new URLSearchParams({
        client_id: env.APPLE_AUDIENCE!,
        client_secret: await appleSecret(env),
        token,
        token_type_hint: 'refresh_token',
      })
    : new URLSearchParams({ token });
  const response = await fetch(
    apple ? 'https://appleid.apple.com/auth/revoke' : 'https://oauth2.googleapis.com/revoke',
    {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (response.ok) return;
  // Google explicitly reports already-expired/revoked tokens as invalid_token.
  if (!apple && response.status === 400) {
    const error = await response.json<{ error?: string }>().catch(() => ({}) as { error?: string });
    if (error.error === 'invalid_token') return;
  }
  throw new Error('Provider revocation unavailable');
}
