import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Image } from 'expo-image';
import { Directory, Paths } from 'expo-file-system';
import { api, APIError, publicAPI, saveCredentials, currentCredentials } from './api';
import { clearAccountDrafts } from './capture';

const receiptKey = 'justtaken.deletion.v1';
export type DeletionStatus = { status: 'PENDING' | 'COMPLETE'; provider_revocation?: string };
export async function pendingDeletion() {
  const saved = await SecureStore.getItemAsync(receiptKey);
  return saved ? (JSON.parse(saved) as { receipt: string; userId: string }) : null;
}
async function clearLocal(userId: string) {
  await clearAccountDrafts(userId);
  // A receipt can outlive its login. Never sign out or erase exports of a different account.
  const current = currentCredentials();
  if (current && current.profile?.userId !== userId) return;
  const exports = new Directory(Paths.cache, 'justtaken-exports');
  if (exports.exists) exports.delete();
  await Image.clearDiskCache();
  await Image.clearMemoryCache();
  if (!currentCredentials() || currentCredentials()?.profile?.userId === userId)
    await saveCredentials(null);
}
export async function refreshDeletion(): Promise<DeletionStatus | null> {
  const saved = await pendingDeletion();
  if (!saved) return null;
  const result = await publicAPI<DeletionStatus>('/v1/account/deletion-status', {
    receipt: saved.receipt,
  });
  await clearLocal(saved.userId);
  return result;
}
export async function forgetDeletionReceipt() {
  await SecureStore.deleteItemAsync(receiptKey);
}
export async function deleteAccount(userId: string) {
  let saved = await pendingDeletion();
  if (!saved || saved.userId !== userId) {
    const receipt = (
      await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join(''),
        { encoding: Crypto.CryptoEncoding.BASE64 },
      )
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    saved = { receipt, userId };
    await SecureStore.setItemAsync(receiptKey, JSON.stringify(saved), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  // A timed-out DELETE may already have been accepted. Recover with the saved private receipt.
  try {
    const recovered = await refreshDeletion();
    if (recovered) return recovered;
  } catch (error) {
    if (!(error instanceof APIError) || error.status !== 404) throw error;
  }
  const result = await api<DeletionStatus>(
    '/v1/me',
    { confirmation: 'DELETE', receipt: saved.receipt },
    'DELETE',
  );
  await clearLocal(userId);
  return result;
}
