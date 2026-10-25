import type { CaptureManifest, CaptureState } from './index';
export interface CaptureSession {
  id: string;
  installationId: string;
  accountBindingId: string;
  nonce: string;
  state: CaptureState;
  commitExpiresAt: number;
  uploadExpiresAt?: number;
}
export class CaptureRuleError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function assertCommitBinding(
  session: CaptureSession,
  manifest: CaptureManifest,
  now: number,
) {
  if (
    session.id !== manifest.sessionId ||
    session.installationId !== manifest.installationId ||
    session.accountBindingId !== manifest.accountBindingId ||
    session.nonce !== manifest.nonce
  )
    throw new CaptureRuleError('SESSION_BINDING_MISMATCH');
  if (session.state !== 'ISSUED') throw new CaptureRuleError('NONCE_ALREADY_CONSUMED');
  if (now >= session.commitExpiresAt) throw new CaptureRuleError('SESSION_EXPIRED');
}
// A saved matching commit response must be checked BEFORE calling the external verifier again.
export function checkReplay(
  saved: { digest: string; response: unknown } | undefined,
  digest: string,
): unknown | undefined {
  if (!saved) return undefined;
  if (saved.digest !== digest) throw new CaptureRuleError('MANIFEST_CONFLICT');
  return saved.response;
}
export function assertUploadWindow(session: CaptureSession, now: number) {
  if (!['COMMITTED', 'UPLOADING'].includes(session.state))
    throw new CaptureRuleError('UPLOAD_NOT_ALLOWED');
  if (!session.uploadExpiresAt || now >= session.uploadExpiresAt)
    throw new CaptureRuleError('UPLOAD_WINDOW_EXPIRED');
}
