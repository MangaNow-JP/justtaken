import type { Bindings } from './types';
import { requireValue } from './http';
import type { ProofTrust } from './proof-verify';

export function publicProofKeys(env: Bindings): ProofTrust {
  requireValue(env.RECEIPT_PRIVATE_JWK && env.RECEIPT_KEY_ID);
  const current = JSON.parse(env.RECEIPT_PRIVATE_JWK);
  const historical = env.RECEIPT_PUBLIC_JWKS ? JSON.parse(env.RECEIPT_PUBLIC_JWKS).keys : [];
  requireValue(Array.isArray(historical) && historical.length <= 32);
  const keys = [...historical, { ...current, kid: env.RECEIPT_KEY_ID }].map((k) => {
    requireValue(
      k.kty === 'EC' &&
        k.crv === 'P-256' &&
        typeof k.x === 'string' &&
        typeof k.y === 'string' &&
        typeof k.kid === 'string',
    );
    // Explicit allowlist, even if an operator accidentally supplies private historical keys.
    return { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, kid: k.kid, alg: 'ES256', use: 'sig' };
  });
  requireValue(new Set(keys.map((k) => k.kid)).size === keys.length);
  return { keys, revokedKids: env.REVOKED_RECEIPT_KEY_IDS?.split(',').filter(Boolean) ?? [] };
}

export function proofIssuer(env: Bindings): string {
  requireValue(env.API_ORIGIN);
  const url = new URL(env.API_ORIGIN);
  requireValue(
    url.href === url.origin + '/' &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (env.ENVIRONMENT !== 'production' &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', 'test'].includes(url.hostname))),
  );
  return url.origin;
}
