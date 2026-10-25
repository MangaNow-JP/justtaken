import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import {
  api,
  publicAPI,
  onCredentials,
  restoreCredentials,
  saveCredentials,
  type Credentials,
  type Profile,
} from './api';
export type Policy = { providers: { apple: boolean; google: boolean }; captureEnabled: boolean };
const Context = createContext<{
  profile: Profile | null;
  loading: boolean;
  policy: Policy | null;
  connectionError: string;
  reload: () => Promise<void>;
}>({ profile: null, loading: true, policy: null, connectionError: '', reload: async () => {} });
export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true),
    [policy, setPolicy] = useState<Policy | null>(null),
    [connectionError, setError] = useState('');
  async function reload() {
    try {
      setPolicy(await publicAPI<Policy>('/v1/policy'));
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '接続できませんでした。');
    }
  }
  useEffect(() => {
    const unsubscribe = onCredentials((c) => setProfile(c?.profile ?? null));
    void (async () => {
      try {
        await restoreCredentials();
        await reload();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'ログイン情報を読み込めませんでした。');
      } finally {
        setLoading(false);
      }
    })();
    return unsubscribe;
  }, []);
  return (
    <Context.Provider value={{ profile, loading, policy, connectionError, reload }}>
      {children}
    </Context.Provider>
  );
}
export const useAuth = () => useContext(Context);
export async function signIn(provider: 'apple' | 'google') {
  if (Platform.OS === 'web') throw new Error('ログインはiPhone・Androidアプリでご利用ください。');
  let result: Credentials;
  if (provider === 'apple') {
    if (!(await AppleAuthentication.isAvailableAsync()))
      throw new Error('この端末ではAppleログインを利用できません。');
    const challenge = await publicAPI<{ challengeId: string; nonce: string }>(
      '/v1/auth/challenge',
      { provider },
    );
    const credential = await AppleAuthentication.signInAsync({
      nonce: challenge.nonce,
      state: challenge.challengeId,
      requestedScopes: [],
    });
    if (!credential.identityToken || credential.state !== challenge.challengeId)
      throw new Error('ログイン情報を確認できませんでした。');
    result = await publicAPI<Credentials>('/v1/auth/exchange', {
      provider,
      challengeId: challenge.challengeId,
      idToken: credential.identityToken,
    });
  } else {
    const verifier = Array.from(Crypto.getRandomBytes(32), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const codeChallenge = (
      await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.BASE64,
      })
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const challenge = await publicAPI<{ challengeId: string; authorizationURL: string }>(
      '/v1/auth/challenge',
      { provider, codeChallenge },
    );
    const callback = 'justtaken-dev://auth';
    const response = await WebBrowser.openAuthSessionAsync(challenge.authorizationURL, callback);
    if (response.type !== 'success') return;
    const url = new URL(response.url);
    if (
      url.protocol !== 'justtaken-dev:' ||
      url.host !== 'auth' ||
      url.searchParams.get('challengeId') !== challenge.challengeId ||
      !url.searchParams.get('code')
    )
      throw new Error('ログイン応答を確認できませんでした。');
    result = await publicAPI<Credentials>('/v1/auth/exchange', {
      provider,
      challengeId: challenge.challengeId,
      code: url.searchParams.get('code'),
      verifier,
    });
  }
  await saveCredentials(result);
  const me = await api<{ profile: Profile }>('/v1/me');
  await saveCredentials({ ...result, profile: me.profile });
}
