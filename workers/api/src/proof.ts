import { verifyAssertion, verifyAttestation } from 'node-app-attest';
import cbor from 'cbor';
import { X509Certificate } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { canonicalManifest, type CaptureManifest } from '@justtaken/contracts';
import { ApiError, b64, fail, requireValue, sha } from './http';
import type { Bindings } from './types';
export type Installation = {
  id: string;
  userId: string;
  accountBindingId: string;
  platform: 'ios' | 'android';
  challenge: string;
  expires: number;
  active: boolean;
  keyId?: string;
  publicKey?: string;
  counter: number;
  environment?: string;
};
export function integrityConfigured(env: Bindings, platform: 'ios' | 'android') {
  return platform === 'ios'
    ? !!(env.APPLE_TEAM_ID && env.APPLE_BUNDLE_ID)
    : !!(
        env.GOOGLE_SERVICE_ACCOUNT &&
        env.ANDROID_PACKAGE &&
        env.ANDROID_CERTIFICATES &&
        env.ANDROID_MIN_VERSION
      );
}
function decodeProof(encoded: unknown): Buffer {
  if (
    typeof encoded !== 'string' ||
    encoded.length > 24_000 ||
    !/^[-A-Za-z0-9+/=_]+$/.test(encoded)
  )
    fail(400, 'INVALID_PROOF', '端末認証の形式が正しくありません。');
  return Buffer.from(encoded! as string, 'base64');
}
export async function verifyEnrollment(
  i: Installation,
  proof: any,
  env: Bindings,
): Promise<Partial<Installation>> {
  requireValue(integrityConfigured(env, i.platform));
  try {
    if (i.platform === 'android') {
      await verifyPlay(proof?.token, await sha(i.challenge), env);
      return { environment: 'production' };
    }
    const attestation = decodeProof(proof?.attestation);
    // The upstream verifier authenticates the chain, app ID, challenge, key and AAGUID.
    // Enforce validity periods, CA roles, bounded CBOR and a single object here as well.
    const decoded = cbor.decodeAllSync(attestation, { preventDuplicateKeys: true, max_depth: 12 });
    if (decoded.length !== 1 || decoded[0]?.attStmt?.x5c?.length !== 2)
      throw new Error('Malformed chain');
    const certs = decoded[0].attStmt.x5c.map((b: Buffer) => new X509Certificate(b));
    for (const cert of certs)
      if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) < Date.now())
        throw new Error('Expired certificate');
    if (certs[0].ca || !certs[1].ca) throw new Error('Invalid certificate role');
    const result = verifyAttestation({
      attestation,
      challenge: i.challenge,
      keyId: proof.keyId,
      bundleIdentifier: env.APPLE_BUNDLE_ID!,
      teamIdentifier: env.APPLE_TEAM_ID!,
      allowDevelopmentEnvironment: env.ENVIRONMENT !== 'production',
    });
    return { keyId: proof.keyId, publicKey: result.publicKey, environment: result.environment };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      403,
      'ATTESTATION_REJECTED',
      '端末認証を確認できませんでした。対応する実機でお試しください。',
    );
  }
}
export async function verifyCaptureProof(
  i: Installation,
  manifest: CaptureManifest,
  proof: any,
  env: Bindings,
): Promise<number> {
  try {
    const payload = 'CAPTURE_SNS_V1\0' + canonicalManifest(manifest);
    if (i.platform === 'android') {
      await verifyPlay(proof?.token, await sha(payload), env);
      return i.counter;
    }
    if (proof?.keyId !== i.keyId || !i.publicKey) throw new Error('Key mismatch');
    const assertion = decodeProof(proof.assertion);
    const decoded = cbor.decodeAllSync(assertion, { preventDuplicateKeys: true, max_depth: 8 });
    if (
      decoded.length !== 1 ||
      !Buffer.isBuffer(decoded[0].authenticatorData) ||
      decoded[0].authenticatorData.length !== 37 ||
      !Buffer.isBuffer(decoded[0].signature)
    )
      throw new Error('Invalid assertion');
    const result = verifyAssertion({
      assertion,
      payload,
      publicKey: i.publicKey,
      bundleIdentifier: env.APPLE_BUNDLE_ID!,
      teamIdentifier: env.APPLE_TEAM_ID!,
      signCount: i.counter,
    });
    return result.signCount;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      403,
      'CAPTURE_PROOF_REJECTED',
      '撮影記録の認証に失敗しました。もう一度撮影してください。',
    );
  }
}
export function assertPlayVerdict(
  payload: any,
  digest: string,
  env: Pick<Bindings, 'ANDROID_PACKAGE' | 'ANDROID_CERTIFICATES' | 'ANDROID_MIN_VERSION'>,
  now = Date.now(),
): void {
  requireValue(
    Number.isSafeInteger(Number(env.ANDROID_MIN_VERSION)) && Number(env.ANDROID_MIN_VERSION) > 0,
  );
  const details = payload?.requestDetails,
    app = payload?.appIntegrity;
  const timestamp = Number(details?.timestampMillis),
    version = Number(app?.versionCode);
  const certificates = env.ANDROID_CERTIFICATES?.split(',').map((s) => s.trim());
  if (
    details?.requestPackageName !== env.ANDROID_PACKAGE ||
    details?.requestHash !== b64(Buffer.from(digest, 'hex')) ||
    !Number.isSafeInteger(timestamp) ||
    now - timestamp > 120_000 ||
    timestamp > now + 30_000 ||
    app?.appRecognitionVerdict !== 'PLAY_RECOGNIZED' ||
    app?.packageName !== env.ANDROID_PACKAGE ||
    !Number.isSafeInteger(version) ||
    version < Number(env.ANDROID_MIN_VERSION) ||
    !app?.certificateSha256Digest?.some((c: string) => certificates?.includes(c)) ||
    !payload?.deviceIntegrity?.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY') ||
    payload?.accountDetails?.appLicensingVerdict !== 'LICENSED'
  )
    fail(403, 'INTEGRITY_REJECTED', 'Google Playの端末認証を確認できませんでした。');
}
let googleAccess: { email: string; token: string; expires: number } | undefined;
async function verifyPlay(encoded: unknown, digest: string, env: Bindings): Promise<void> {
  requireValue(integrityConfigured(env, 'android'));
  if (typeof encoded !== 'string' || encoded.length < 16 || encoded.length > 20_000)
    fail(400, 'INVALID_PROOF', '端末認証がありません。');
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT!) as {
    client_email: string;
    private_key: string;
  };
  if (
    !googleAccess ||
    googleAccess.email !== account.client_email ||
    googleAccess.expires < Date.now() + 60_000
  ) {
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/playintegrity' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(account.client_email)
      .setAudience('https://oauth2.googleapis.com/token')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok)
      fail(503, 'INTEGRITY_UNAVAILABLE', '端末認証に接続できませんでした。再試行してください。');
    const t = await res.json<{ access_token: string; expires_in: number }>();
    googleAccess = {
      email: account.client_email,
      token: t.access_token,
      expires: Date.now() + t.expires_in * 1000,
    };
  }
  const response = await fetch(
    `https://playintegrity.googleapis.com/v1/${encodeURIComponent(env.ANDROID_PACKAGE!)}:decodeIntegrityToken`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${googleAccess.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ integrity_token: encoded }),
    },
  );
  if (!response.ok)
    fail(
      response.status >= 500 ? 503 : 403,
      'INTEGRITY_REJECTED',
      '端末認証を確認できませんでした。',
    );
  const data = await response.json<{ tokenPayloadExternal: unknown }>();
  assertPlayVerdict(data.tokenPayloadExternal, digest, env);
}
