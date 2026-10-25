import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { captureModule, type CaptureSessionBinding, type LocalCapture } from '@justtaken/capture';
import { API_URL, api, accessToken, APIError } from './api';
import * as Crypto from 'expo-crypto';
export interface ServerPost {
  post_id: string;
  author_id: string;
  caption: string;
  visibility: 'private' | 'followers' | 'public';
  state: string;
  moderation: string;
  display_name: string;
  server_verified_at: string | null;
  created_at: string;
}
export type UploadPhase =
  'authenticating' | 'committing' | 'uploading' | 'verifying' | 'certifying' | 'posting' | 'done';
interface Enrollment {
  installationId: string;
  accountBindingId: string;
  challenge: string;
  expiresAt: number;
  ready?: boolean;
}
let preparing: Promise<CaptureSessionBinding> | null = null;
let activeUpload: Promise<unknown> = Promise.resolve();
export async function prepareCapture(userId: string): Promise<CaptureSessionBinding> {
  if (preparing) {
    await preparing.catch(() => {});
    return prepareCapture(userId);
  }
  preparing = (async () => {
    if (!captureModule || !captureModule.supportsPhotoCapture)
      throw new Error('撮影認証はiPhone・Androidの実機でご利用ください。');
    const key =
      'justtaken.installation.' +
      (await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        API_URL + '\0' + userId,
      ));
    let entry: Enrollment | null = null;
    try {
      const raw = await SecureStore.getItemAsync(key);
      if (raw) entry = JSON.parse(raw);
    } catch {}
    if (!entry || (!entry.ready && entry.expiresAt <= Date.now())) {
      entry = await api<Enrollment>('/v1/installations', { platform: Platform.OS });
      await SecureStore.setItemAsync(key, JSON.stringify(entry));
    }
    if (!entry.ready) {
      const proof = await captureModule.enroll(entry.installationId, entry.challenge);
      await api(`/v1/installations/${entry.installationId}/attest`, { proof });
      entry.ready = true;
      await SecureStore.setItemAsync(key, JSON.stringify(entry));
    }
    return api<CaptureSessionBinding>('/v1/capture-sessions', {
      installationId: entry.installationId,
    });
  })().finally(() => {
    preparing = null;
  });
  return preparing;
}
function path(c: LocalCapture) {
  if (!c.session)
    throw new Error('この下書きには撮影認証がありません。ログイン後にもう一度撮影してください。');
  return `/v1/installations/${c.session.installationId}/captures/${c.session.sessionId}`;
}
async function commit(c: LocalCapture) {
  const prefix = path(c),
    status = await api<{ state: string }>(prefix);
  if (['COMMITTED', 'UPLOADING', 'VERIFIED'].includes(status.state)) return;
  if (status.state !== 'ISSUED')
    throw new Error('この撮影記録の有効時間が過ぎました。もう一度撮影してください。');
  const proof = await captureModule!.prepareProof(c.handle);
  await api(prefix + '/commit', proof);
}
export function commitCapture(c: LocalCapture) {
  const operation = activeUpload.catch(() => {}).then(() => commit(c));
  activeUpload = operation;
  return operation;
}
async function verifyUploadedCapture(c: LocalCapture, progress: (p: UploadPhase) => void) {
  if (!captureModule) throw new Error('専用アプリでご利用ください。');
  progress('committing');
  await commit(c);
  const prefix = path(c),
    status = await api<{ state: string }>(prefix);
  if (status.state !== 'VERIFIED') {
    progress('uploading');
    for (const asset of c.assets)
      await captureModule.upload(c.handle, asset.id, await accessToken());
    progress('verifying');
    await api(prefix + '/complete', {});
  }
}
export function certifyCapture(c: LocalCapture, progress: (p: UploadPhase) => void) {
  const operation = activeUpload
    .catch(() => {})
    .then(async () => {
      await verifyUploadedCapture(c, progress);
      progress('certifying');
      await api('/v1/proofs', {
        installationId: c.session!.installationId,
        captureId: c.session!.sessionId,
      });
      progress('done');
    });
  activeUpload = operation;
  return operation;
}
export function postCapture(
  c: LocalCapture,
  caption: string,
  visibility: 'private' | 'followers',
  progress: (p: UploadPhase) => void,
): Promise<ServerPost> {
  const operation = activeUpload
    .catch(() => {})
    .then(async () => {
      await verifyUploadedCapture(c, progress);
      progress('certifying');
      await api('/v1/proofs', {
        installationId: c.session!.installationId,
        captureId: c.session!.sessionId,
      });
      progress('posting');
      const result = await api<{ post: ServerPost }>('/v1/posts', {
        installationId: c.session!.installationId,
        captureId: c.session!.sessionId,
        caption,
        visibility,
      });
      progress('done');
      return result.post;
    });
  activeUpload = operation;
  return operation;
}
export async function discardCapture(c: LocalCapture) {
  if (c.session) {
    try {
      const status = await api<{ state: string }>(path(c));
      // Removing an on-device draft must not destroy a certified vault original.
      if (status.state !== 'VERIFIED') await api(path(c), undefined, 'DELETE');
    } catch (error) {
      if (!(error instanceof APIError) || error.status !== 404) throw error;
    }
  }
  await captureModule?.discard(c.handle);
}

export async function listAccountDrafts(userId?: string): Promise<LocalCapture[]> {
  if (!captureModule) return [];
  const drafts = await captureModule.listDrafts();
  if (!userId) return drafts.filter((c) => !c.session);
  const key =
    'justtaken.installation.' +
    (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, API_URL + '\0' + userId));
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return [];
  const entry = JSON.parse(raw) as Enrollment;
  return drafts.filter((c) => c.session?.accountBindingId === entry.accountBindingId);
}
