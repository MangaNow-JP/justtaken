import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiError, requireValue } from './http';
import type { Bindings } from './types';
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
  timeoutDuration: 5000,
});
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 5000,
});
export function assertIdentityClaims(payload: JWTPayload, nonce: string): string {
  if (
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    payload.sub.length > 255 ||
    payload.nonce !== nonce ||
    !payload.exp ||
    !payload.iat ||
    payload.iat > Date.now() / 1000 + 30
  )
    throw new ApiError(
      401,
      'INVALID_IDENTITY',
      'ログイン情報を確認できませんでした。もう一度ログインしてください。',
    );
  return payload.sub;
}
export async function verifyIdentity(
  provider: 'apple' | 'google',
  idToken: string,
  nonce: string,
  env: Bindings,
): Promise<string> {
  const audience = provider === 'apple' ? env.APPLE_AUDIENCE : env.GOOGLE_CLIENT_ID;
  requireValue(audience);
  try {
    const { payload } = await jwtVerify(idToken, provider === 'apple' ? appleKeys : googleKeys, {
      algorithms: ['RS256'],
      audience,
      issuer:
        provider === 'apple'
          ? 'https://appleid.apple.com'
          : ['https://accounts.google.com', 'accounts.google.com'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      clockTolerance: 30,
    });
    if (payload.azp && payload.azp !== audience) throw new Error('Unexpected authorized party');
    return assertIdentityClaims(payload, nonce);
  } catch {
    throw new ApiError(
      401,
      'INVALID_IDENTITY',
      'ログイン情報を確認できませんでした。もう一度ログインしてください。',
    );
  }
}
