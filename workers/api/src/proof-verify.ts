import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { proofSchema, proofBundleSchema } from '@justtaken/contracts/proof';

export interface ProofTrust extends JSONWebKeySet {
  revokedKids?: string[];
}
// The caller supplies a trusted issuer and its keys, never keys/URLs from the file.
export async function verifyProof(bundle: unknown, issuer: string, trust: ProofTrust) {
  const { certificate } = proofBundleSchema.parse(bundle);
  const result = await compactVerify(certificate, createLocalJWKSet(trust), {
    algorithms: ['ES256'],
  });
  const h = result.protectedHeader;
  if (
    h.typ !== 'justtaken-proof+jws' ||
    typeof h.kid !== 'string' ||
    Object.keys(h).some((k) => !['alg', 'kid', 'typ'].includes(k)) ||
    trust.revokedKids?.includes(h.kid)
  )
    throw new Error('証明の署名鍵を信頼できません。');
  const proof = proofSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.payload)),
  );
  if (proof.issuer !== issuer) throw new Error('証明の発行元が一致しません。');
  if (
    Date.parse(proof.serverCommittedAt) > Date.parse(proof.serverVerifiedAt) ||
    Date.parse(proof.serverVerifiedAt) > Date.parse(proof.issuedAt)
  )
    throw new Error('サーバーの記録日時が不正です。');
  return proof;
}
