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
  currentCredentials,
  logout,
  type Credentials,
  type Profile,
} from './api';
export type Policy = {
  providers: { apple: boolean; google: boolean };
  captureEnabled: boolean;
  community: { termsVersion: string; privacyVersion: string; minimumAge: number };
};
const Context = createContext<{
  profile: Profile | null;
  loading: boolean;
  policy: Policy | null;
  connectionError: string;
  consentRequired: boolean;
  reload: () => Promise<void>;
}>({
  profile: null,
  loading: true,
  policy: null,
  connectionError: '',
  consentRequired: false,
  reload: async () => {},
});
export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true),
    [policy, setPolicy] = useState<Policy | null>(null),
    [connectionError, setError] = useState('');
  const [consentRequired, setConsentRequired] = useState(false);
  async function reload() {
    try {
      setPolicy(await publicAPI<Policy>('/v1/policy'));
      if (currentCredentials()) {
        const consent = await api<{ required: boolean }>('/v1/me/consent');
        setConsentRequired(consent.required);
      } else setConsentRequired(false);
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '接続できませんでした。');
    }
  }
  useEffect(() => {
    const unsubscribe = onCredentials((c) => setProfile(c?.profile ?? null));
    const revoked =
      Platform.OS === 'ios'
        ? AppleAuthentication.addRevokeListener(() => {
            if (currentCredentials()?.appleUser)
              void logout(true).catch(() => saveCredentials(null));
          })
        : null;
    void (async () => {
      try {
        await restoreCredentials();
        const restored = currentCredentials();
        if (Platform.OS === 'ios' && restored?.appleUser) {
          const state = await AppleAuthentication.getCredentialStateAsync(restored.appleUser);
          if (state !== AppleAuthentication.AppleAuthenticationCredentialState.AUTHORIZED)
            await logout(true).catch(() => saveCredentials(null));
        }
        if (currentCredentials()) {
          const me = await api<{ profile: Profile }>('/v1/me');
          const saved = currentCredentials();
          if (saved) await saveCredentials({ ...saved, profile: me.profile });
        }
        await reload();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'ログイン情報を読み込めませんでした。');
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      unsubscribe();
      revoked?.remove();
    };
  }, []);
  return (
    <Context.Provider
      value={{ profile, loading, policy, connectionError, consentRequired, reload }}
    >
      {children}
    </Context.Provider>
  );
}
export const useAuth = () => useContext(Context);
export async function signIn(
  provider: 'apple' | 'google',
  consent: { termsVersion: string; privacyVersion: string; ageConfirmed18Plus: true },
) {
  if (Platform.OS === 'web') throw new Error('ログインはiPhone・Androidアプリでご利用ください。');
  let result: Credentials;
  if (provider === 'apple') {
    if (!(await AppleAuthentication.isAvailableAsync()))
      throw new Error('この端末ではAppleログインを利用できません。');
    const challenge = await publicAPI<{ challengeId: string; nonce: string }>(
      '/v1/auth/challenge',
      { provider, ageConfirmed18Plus: consent.ageConfirmed18Plus },
    );
    const credential = await AppleAuthentication.signInAsync({
      nonce: challenge.nonce,
      state: challenge.challengeId,
      requestedScopes: [],
    });
    if (
      !credential.identityToken ||
      !credential.authorizationCode ||
      credential.state !== challenge.challengeId
    )
      throw new Error('ログイン情報を確認できませんでした。');
    result = await publicAPI<Credentials>('/v1/auth/exchange', {
      provider,
      challengeId: challenge.challengeId,
      idToken: credential.identityToken,
      authorizationCode: credential.authorizationCode,
    });
    result.appleUser = credential.user;
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
      { provider, codeChallenge, ageConfirmed18Plus: consent.ageConfirmed18Plus },
    );
    const callback = `${process.env.EXPO_PUBLIC_AUTH_SCHEME || 'justtaken-dev'}://auth`;
    const response = await WebBrowser.openAuthSessionAsync(challenge.authorizationURL, callback);
    if (response.type !== 'success') return;
    const url = new URL(response.url);
    if (
      url.protocol !== new URL(callback).protocol ||
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
  await api('/v1/me/consent', consent);
  const me = await api<{ profile: Profile }>('/v1/me');
  await saveCredentials({ ...result, profile: me.profile });
}
