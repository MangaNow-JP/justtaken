import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8787').replace(
  /\/$/,
  '',
);
export type Profile = {
  userId: string;
  displayName: string;
  bio?: string;
  isPrivate: boolean;
  moderator?: boolean;
};
export type Credentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  profile?: Profile;
  appleUser?: string;
};
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
let credentials: Credentials | null = null;
let refreshing: Promise<void> | null = null;
let listener: (value: Credentials | null) => void = () => {};
const key = 'justtaken.auth.v1';
function storageUnavailable() {
  return new APIError(
    0,
    'SECURE_STORAGE_UNAVAILABLE',
    'この端末ではログイン情報を安全に保存できません。対応する署名済みアプリでお試しください。',
  );
}
export function onCredentials(fn: typeof listener) {
  listener = fn;
  return () => {
    listener = () => {};
  };
}
export function currentCredentials() {
  return credentials;
}
export async function saveCredentials(value: Credentials | null) {
  if (Platform.OS !== 'web') {
    try {
      if (value)
        await SecureStore.setItemAsync(key, JSON.stringify(value), {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
      else await SecureStore.deleteItemAsync(key);
    } catch {
      throw storageUnavailable();
    }
  }
  credentials = value;
  listener(value);
}
export async function restoreCredentials() {
  if (Platform.OS === 'web') return;
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(key);
  } catch {
    throw storageUnavailable();
  }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (
      typeof data.refreshToken !== 'string' ||
      typeof data.accessToken !== 'string' ||
      typeof data.expiresAt !== 'number'
    )
      throw new Error();
    credentials = data;
    listener(data);
  } catch {
    await saveCredentials(null);
  }
}
export async function publicAPI<T>(path: string, data?: unknown): Promise<T> {
  return request(
    path,
    {
      method: data === undefined ? 'GET' : 'POST',
      body: data === undefined ? undefined : JSON.stringify(data),
    },
    false,
  );
}
async function request<T>(path: string, init: RequestInit, authorized: boolean): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API_URL + path, {
      ...init,
      signal: AbortSignal.timeout(
        path.endsWith('/complete') ? 180_000 : path.startsWith('/v1/proofs') ? 90_000 : 30_000,
      ),
      headers: {
        'Content-Type': 'application/json',
        ...(authorized && credentials
          ? { Authorization: 'Bearer ' + credentials.accessToken }
          : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new APIError(
      0,
      'NETWORK_ERROR',
      '接続できませんでした。通信状態を確認して再試行してください。',
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new APIError(
      response.status,
      data?.error?.code ?? 'REQUEST_FAILED',
      data?.error?.message ?? '処理を完了できませんでした。',
      data?.error?.requestId,
    );
  return data as T;
}
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!credentials) throw new APIError(401, 'LOGIN_REQUIRED', 'ログインしてください。');
    const previous = credentials;
    try {
      const next = await publicAPI<Credentials>('/v1/auth/refresh', {
        refreshToken: previous.refreshToken,
      });
      if (credentials !== previous) return;
      await saveCredentials({ ...next, profile: previous.profile, appleUser: previous.appleUser });
    } catch (error) {
      if (error instanceof APIError && error.status === 401) await saveCredentials(null);
      throw error;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
export async function accessToken() {
  if (!credentials) throw new APIError(401, 'LOGIN_REQUIRED', 'ログインしてください。');
  if (credentials.expiresAt < Date.now() + 60_000) await refresh();
  return credentials!.accessToken;
}
export async function api<T>(path: string, data?: unknown, method?: string): Promise<T> {
  await accessToken();
  const init = {
    method: method ?? (data === undefined ? 'GET' : 'POST'),
    body: data === undefined ? undefined : JSON.stringify(data),
  };
  try {
    return await request<T>(path, init, true);
  } catch (error) {
    if (!(error instanceof APIError) || error.status !== 401) throw error;
    await refresh();
    return request<T>(path, init, true);
  }
}
export async function logout(all = false) {
  if (all) {
    await api('/v1/auth/logout-all', {});
    await saveCredentials(null);
    return;
  }
  try {
    await api('/v1/auth/logout', {});
  } finally {
    await saveCredentials(null);
  }
}
