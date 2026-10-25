import { z } from 'zod';
import { baseAsset } from './index';

// Public certificate deliberately omits installation ID, nonce, account binding,
// device identifiers, location, original receipt and the private capture manifest.
export const proofSchema = z
  .object({
    version: z.literal(1),
    issuer: z.url(),
    proofId: z.uuid(),
    creatorId: z.uuid(),
    issuedAt: z.iso.datetime(),
    deviceCapturedAt: z.iso.datetime(),
    serverCommittedAt: z.iso.datetime(),
    serverVerifiedAt: z.iso.datetime(),
    policyVersion: z.enum(['capture-v1', 'capture-v2', 'capture-v3']),
    kind: z.enum(['photo', 'video']),
    original: baseAsset.extend({ id: z.literal('original'), role: z.literal('original') }),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidence: z
      .object({
        method: z.enum(['apple-app-attest', 'google-play-integrity']),
        deviceEnvironment: z.enum(['production', 'development', 'test']),
        serviceEnvironment: z.enum(['production', 'development', 'test']),
      })
      .strict(),
    scope: z.literal('app-capture-and-file-integrity'),
    subjectTruthGuaranteed: z.literal(false),
    personIdentityVerified: z.literal(false),
    // Signed requirement: stripping external evidence never upgrades this to verified.
    anchorPolicy: z.literal('rfc3161-rekor-v1').optional(),
  })
  .strict();
export type CaptureProof = z.infer<typeof proofSchema>;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const b64 = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const logEntrySchema = z
  .object({
    body: b64(16384),
    logID: hex,
    logIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    integratedTime: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    verification: z
      .object({
        signedEntryTimestamp: b64(1024),
        inclusionProof: z
          .object({
            logIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            treeSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            rootHash: hex,
            hashes: z.array(hex).max(64),
            checkpoint: z.string().min(1).max(8192),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const proofAnchorsSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('sigstore-v1'),
    nonce: z.string().regex(/^[0-7][a-f0-9]{31}$/),
    timestamp: b64(49152),
    log: logEntrySchema,
  })
  .strict();
export type ProofAnchors = z.infer<typeof proofAnchorsSchema>;
export const proofBundleSchema = z
  .object({
    format: z.literal('justtaken-proof-v1'),
    certificate: z.string().min(1).max(16384),
    anchors: proofAnchorsSchema.optional(),
  })
  .strict();
export type ProofBundle = z.infer<typeof proofBundleSchema>;
