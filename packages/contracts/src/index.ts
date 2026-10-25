import { z } from 'zod';
import { captureLocationSchema } from './location';
export { captureLocationSchema, locationSummary, type CaptureLocation } from './location';

import { capturePolicy, legacyCapturePolicy, originalCapturePolicy } from './policy';
export { capturePolicy, mediaExtension } from './policy';
export { countGraphemes } from './text';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const baseAsset = z
  .object({
    id: z.enum(['original', 'thumbnail', 'poster']),
    role: z.enum(['original', 'thumbnail', 'poster']),
    mime: z.enum(['image/jpeg', 'image/heic', 'image/x-adobe-dng', 'video/mp4']),
    bytes: integer,
    width: integer,
    height: integer,
    sha256: hash,
    preservation: z.literal('camera-original').optional(),
    hasGainMap: z.boolean().optional(),
    durationMs: integer.optional(),
    videoCodec: z.enum(['h264', 'hevc']).optional(),
    orientation: z.number().int().min(1).max(8).optional(),
    rotationDegrees: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .optional(),
    videoBitDepth: z.union([z.literal(8), z.literal(10)]).optional(),
    colorTransfer: z.enum(['sdr', 'hlg', 'pq']).optional(),
    audioCodec: z.literal('aac-lc').optional(),
    fpsNumerator: integer.optional(),
    fpsDenominator: integer.optional(),
  })
  .strict();
export const manifestSchema = z
  .object({
    version: z.literal(1),
    policyVersion: z.enum(['capture-v1', 'capture-v2', 'capture-v3']),
    sessionId: id,
    installationId: id,
    accountBindingId: id,
    clientCaptureId: id,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    clientCapturedAt: z.iso.datetime(),
    kind: z.enum(['photo', 'video']),
    location: captureLocationSchema.optional(),
    assets: z.array(baseAsset).length(2),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const policy =
      manifest.policyVersion === 'capture-v1'
        ? legacyCapturePolicy
        : manifest.policyVersion === 'capture-v2'
          ? originalCapturePolicy
          : capturePolicy;
    if (manifest.location) {
      if (manifest.policyVersion === 'capture-v1')
        ctx.addIssue({ code: 'custom', message: 'Location requires capture-v2 or later.' });
      if (manifest.location.status === 'recorded') {
        const age =
          Date.parse(manifest.clientCapturedAt) - Date.parse(manifest.location.measuredAt);
        if (age < 0 || age > 15_000)
          ctx.addIssue({
            code: 'custom',
            message: 'Location must be measured within 15 seconds before capture.',
          });
      }
    }
    const [original, small] = manifest.assets;
    if (!original || !small) return;
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (original.id !== 'original' || original.role !== 'original')
      issue('Original must be first.');
    const smallRole = manifest.kind === 'photo' ? 'thumbnail' : 'poster';
    if (small.id !== smallRole || small.role !== smallRole || small.mime !== 'image/jpeg')
      issue('Invalid preview asset.');
    if (small.bytes > capturePolicy.thumbnailMaxBytes || Math.max(small.width, small.height) > 480)
      issue('Preview exceeds policy.');
    for (const asset of manifest.assets) {
      if (
        asset.mime !== 'video/mp4' &&
        [
          asset.rotationDegrees,
          asset.videoBitDepth,
          asset.colorTransfer,
          asset.durationMs,
          asset.videoCodec,
          asset.audioCodec,
          asset.fpsNumerator,
          asset.fpsDenominator,
        ].some((v) => v !== undefined)
      )
        issue('Video fields on photo.');
      if (
        (manifest.policyVersion !== 'capture-v3' ||
          asset.role !== 'original' ||
          manifest.kind !== 'photo') &&
        (asset.preservation !== undefined || asset.hasGainMap !== undefined)
      )
        issue('Original photo fields outside v3 photo.');
    }
    if (small.orientation !== undefined && small.orientation !== 1)
      issue('Preview must be upright.');
    if (manifest.kind === 'photo') {
      if (manifest.policyVersion !== 'capture-v1' && original.orientation === undefined)
        issue('Missing photo orientation.');
      if (
        !(manifest.policyVersion === 'capture-v3'
          ? ['image/jpeg', 'image/heic', 'image/x-adobe-dng'].includes(original.mime)
          : original.mime === 'image/jpeg') ||
        original.bytes >
          (original.mime === 'image/x-adobe-dng'
            ? capturePolicy.rawMaxBytes
            : policy.photoMaxBytes) ||
        Math.max(original.width, original.height) > policy.photoMaxEdge ||
        original.width * original.height > capturePolicy.photoMaxPixels
      )
        issue('Photo exceeds policy.');
      if (
        manifest.policyVersion === 'capture-v3' &&
        (original.preservation !== 'camera-original' || original.hasGainMap === undefined)
      )
        issue('Original preservation declaration required.');
    } else {
      if (
        original.mime !== 'video/mp4' ||
        original.bytes > policy.videoMaxBytes ||
        Math.max(original.width, original.height) > policy.videoMaxLongEdge ||
        Math.min(original.width, original.height) > policy.videoMaxShortEdge
      )
        issue('Video exceeds policy.');
      if (
        !original.durationMs ||
        original.durationMs > 60_000 ||
        !original.videoCodec ||
        !original.fpsNumerator ||
        !original.fpsDenominator ||
        original.fpsNumerator / original.fpsDenominator > policy.videoMaxFps
      )
        issue('Invalid video duration, codec, or frame rate.');
      if (
        original.colorTransfer &&
        original.colorTransfer !== 'sdr' &&
        original.videoBitDepth !== 10
      )
        issue('HDR requires 10-bit video.');
      if (original.videoCodec === 'h264' && original.videoBitDepth === 10)
        issue('Only HEVC supports 10-bit capture.');
      if (original.orientation !== undefined) issue('Photo orientation on video.');
      if (
        manifest.policyVersion !== 'capture-v1' &&
        (!original.videoBitDepth ||
          !original.colorTransfer ||
          original.rotationDegrees === undefined)
      )
        issue('Missing original video format.');
      if (
        manifest.policyVersion === 'capture-v1' &&
        (original.videoCodec !== 'h264' ||
          original.videoBitDepth === 10 ||
          (original.colorTransfer && original.colorTransfer !== 'sdr'))
      )
        issue('Unsupported legacy video format.');
    }
  });
export type CaptureManifest = z.infer<typeof manifestSchema>;
export type CaptureState =
  | 'ISSUED'
  | 'COMMITTED'
  | 'UPLOADING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'CANCELLED';
export type Visibility = 'public' | 'followers' | 'private';

// Validated manifests contain only finite integers, ASCII keys, and valid Unicode strings.
// ECMAScript string serialization and UTF-16 key sorting implement the JCS subset here.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .sort()
      .filter((k) => object[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(object[k]))
      .join(',') +
    '}'
  );
}
export function canonicalManifest(input: unknown): string {
  return canonicalize(manifestSchema.parse(input));
}
export async function manifestDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode('CAPTURE_SNS_V1\0' + canonicalManifest(input));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export function canPublish(input: {
  captureState: CaptureState;
  mediaReady: boolean;
  moderation: 'pending' | 'allowed' | 'blocked';
  accountActive: boolean;
  deleted: boolean;
}): boolean {
  return (
    input.captureState === 'VERIFIED' &&
    input.mediaReady &&
    input.moderation === 'allowed' &&
    input.accountActive &&
    !input.deleted
  );
}
export function canViewPost(input: {
  isOwner: boolean;
  accountPrivate: boolean;
  approvedFollower: boolean;
  blocked: boolean;
  postState: string;
  visibility: Visibility;
}): boolean {
  if (input.blocked || input.postState === 'DELETED' || input.postState === 'HIDDEN') return false;
  if (input.isOwner) return true;
  if (input.postState !== 'PUBLISHED' || input.visibility === 'private') return false;
  return (input.visibility === 'public' && !input.accountPrivate) || input.approvedFollower;
}
