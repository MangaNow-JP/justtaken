import { z } from 'zod';

export const communityPolicy = Object.freeze({
  termsVersion: '2026-10-29.1',
  privacyVersion: '2026-10-30.1',
  minimumAge: 18,
  ageAssurance: 'self_declaration',
  ageConfirmationVersion: '18-plus-2026-10-29.1',
  termsURL: 'https://justtaken.app/terms',
  privacyURL: 'https://justtaken.app/privacy',
});

export const reportReasons = [
  'spam',
  'harassment',
  'sexual',
  'child_safety',
  'violence',
  'illegal',
  'privacy',
  'other',
] as const;
export type ReportReason = (typeof reportReasons)[number];
export const reportReasonLabels: Record<ReportReason, string> = {
  spam: 'スパム・迷惑行為',
  harassment: '嫌がらせ・いじめ',
  sexual: '性的な内容',
  child_safety: '子どもの安全に関わる内容',
  violence: '暴力・危険な行為',
  illegal: '違法な内容',
  privacy: 'プライバシー・権利の侵害',
  other: 'その他',
};

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const authChallengeInputSchema = z
  .object({
    provider: z.enum(['apple', 'google']),
    codeChallenge: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    ageConfirmed18Plus: z.literal(true),
  })
  .strict();
export const consentInputSchema = z
  .object({
    termsVersion: z.literal(communityPolicy.termsVersion),
    privacyVersion: z.literal(communityPolicy.privacyVersion),
    ageConfirmed18Plus: z.literal(true),
  })
  .strict();
export const reportInputSchema = z
  .object({
    userId: id,
    postId: id.optional(),
    commentId: id.optional(),
    reason: z.enum(reportReasons),
    details: z.string().trim().max(2000).default(''),
  })
  .strict();

export interface ConsentState {
  required: boolean;
  accepted: boolean;
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string | null;
  minimumAge: 18;
  ageAssurance: 'self_declaration';
  ageConfirmed18Plus: boolean;
  ageConfirmedAt: string | null;
}

/** Safety, deletion and read-only routes remain available without consent. */
export function requiresCommunityConsent(method: string, path: string): boolean {
  if (method !== 'POST' && method !== 'PUT') return false;
  if (
    /^\/v1\/users\/[^/]+\/follow$|^\/v1\/follow-requests\/|^\/v1\/posts\/[^/]+\/(like|save|comments)$/.test(
      path,
    )
  )
    return true;
  if (path === '/v1/installations' || path === '/v1/capture-sessions' || path === '/v1/posts')
    return true;
  if (/^\/v1\/installations\/[A-Za-z0-9_-]+\//.test(path)) return true;
  if (/^\/v1\/posts\/[A-Za-z0-9_-]+\/publish$/.test(path)) return true;
  return path === '/v1/proofs' || /^\/v1\/proofs\/[A-Za-z0-9_-]+\/(shares|anchor)$/.test(path);
}
