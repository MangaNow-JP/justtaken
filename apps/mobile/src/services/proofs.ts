import type { CaptureLocation } from '@justtaken/contracts';
import { Platform } from 'react-native';
import type { CaptureProof, ProofBundle } from '@justtaken/contracts/proof';
import { mediaExtension } from '@justtaken/contracts/policy';
import { api, API_URL, accessToken } from './api';
export interface VaultEntry {
  proof: CaptureProof;
  available: boolean;
  activeShares: number;
  anchoring: {
    state: 'anchored' | 'pending' | 'not-configured' | 'not-requested' | 'mismatch';
    retryAt?: number;
    attempts?: number;
    completedAt?: string;
  };
}
export interface VaultPage {
  proofs: VaultEntry[];
  nextCursor: string | null;
}
export const listProofs = (before?: string) =>
  api<VaultPage>('/v1/proofs' + (before ? '?before=' + encodeURIComponent(before) : ''));
export const getProofLocation = (id: string) =>
  api<{ location: CaptureLocation | null }>(`/v1/proofs/${id}/location`);
export const shareProof = (id: string, days: number) =>
  api<{ url: string; expiresAt: number }>(`/v1/proofs/${id}/shares`, { days });
export const revokeProofShares = (id: string) =>
  api(`/v1/proofs/${id}/shares`, undefined, 'DELETE');
export const deleteProof = (id: string) => api(`/v1/proofs/${id}`, undefined, 'DELETE');
export const anchorProof = (id: string) =>
  api<{ anchoring: VaultEntry['anchoring'] }>(`/v1/proofs/${id}/anchor`, {});

export async function exportProofFile(proof: CaptureProof, original = false) {
  const id = proof.proofId;
  const { bundle } = await api<{ bundle: ProofBundle }>(`/v1/proofs/${id}`);
  if (Platform.OS === 'web') {
    if (original) throw new Error('原本の書き出しはiPhone・Androidアプリをご利用ください。');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `JustTaken-${id}.justtaken-proof.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const Sharing = await import('expo-sharing');
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('この端末ではファイル共有を利用できません。');
  const { File, Directory, Paths } = await import('expo-file-system');
  const root = new Directory(Paths.cache, 'justtaken-exports');
  root.create({ idempotent: true });
  // Android receivers may consume a shared file after the sheet returns. Keep it
  // in cache, then remove old export directories on the next export (24 h TTL).
  for (const entry of root.list()) {
    if (
      entry instanceof Directory &&
      /^\d{13}$/.test(entry.name) &&
      Number(entry.name) < Date.now() - 86400_000
    )
      entry.delete();
  }
  const dir = new Directory(root, String(Date.now()));
  dir.create();
  const name = `JustTaken-${id}.${original ? mediaExtension(proof.original.mime) : 'justtaken-proof.json'}`;
  let file = new File(dir, name);
  try {
    if (original) {
      file = await File.downloadFileAsync(API_URL + `/v1/proofs/${id}/original`, file, {
        headers: { Authorization: 'Bearer ' + (await accessToken()) },
      });
      if (file.size !== proof.original.bytes)
        throw new Error('原本を最後まで受信できませんでした。もう一度お試しください。');
    } else {
      file.create();
      file.write(JSON.stringify(bundle, null, 2));
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: original ? proof.original.mime : 'application/json',
      UTI: original
        ? proof.original.mime === 'image/heic'
          ? 'public.heic'
          : proof.original.mime === 'image/x-adobe-dng'
            ? 'com.adobe.raw-image'
            : proof.kind === 'video'
              ? 'public.mpeg-4'
              : 'public.jpeg'
        : 'public.json',
      dialogTitle: original ? '元の形式のまま原本を書き出す' : '署名付き撮影証明を書き出す',
    });
  } catch (error) {
    if (dir.exists) dir.delete();
    throw error;
  }
}
