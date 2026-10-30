import { useState } from 'react';
import { Platform, Text, View, StyleSheet, Pressable } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Button, Icon } from '../components/UI';
import { useAuth, signIn } from '../services/auth';
import { colors as c } from '../theme';
import { LegalLinks } from '../components/LegalLinks';
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const { policy, connectionError, reload } = useAuth();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const native = Platform.OS !== 'web';
  const [agreed, setAgreed] = useState(false);
  const [adult, setAdult] = useState(false);
  async function login(provider: 'apple' | 'google') {
    if (!agreed) {
      setError('利用規約とプライバシーポリシーを確認し、同意してください。');
      return;
    }
    if (!adult || !policy?.community) {
      setError('18歳以上であることをご自身で確認してください。');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await signIn(provider, {
        termsVersion: policy.community.termsVersion,
        privacyVersion: policy.community.privacyVersion,
        ageConfirmed18Plus: true,
      });
      await reload();
      onSuccess();
    } catch (e) {
      if ((e as { code?: string }).code !== 'ERR_REQUEST_CANCELED')
        setError(e instanceof Error ? e.message : 'ログインできませんでした。');
    } finally {
      setBusy(false);
    }
  }
  const configured = policy?.providers.apple || policy?.providers.google;
  return (
    <View style={s.root}>
      <View style={s.mark}>
        <Icon name="camera" size={34} />
      </View>
      <Text style={s.eyebrow}>YOUR EVERYDAY, JUST TAKEN.</Text>
      <Text style={s.title}>{'あなたの日常を、\nあなたのカメラから。'}</Text>
      <Text style={s.copy}>
        ログインして、いま撮った一枚を残しましょう。{'\n'}アカウントは非公開から始まります。
      </Text>
      <View style={s.features}>
        <Icon name="shield" size={18} />
        <Text style={s.featureText}>撮影記録と写真の一致を確認</Text>
      </View>
      <View style={s.features}>
        <Icon name="lock" size={18} />
        <Text style={s.featureText}>共有する相手を自分で選べる</Text>
      </View>
      <View style={s.actions}>
        <LegalLinks />
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed }}
          onPress={() => setAgreed(!agreed)}
          style={{ flexDirection: 'row', gap: 10, paddingVertical: 12 }}
        >
          <Icon name={agreed ? 'check-circle' : 'circle'} size={22} />
          <Text style={{ flex: 1, color: c.ink, lineHeight: 22 }}>
            利用規約・プライバシーポリシーに同意します。不適切な投稿や嫌がらせは禁止されています。
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: adult }}
          onPress={() => setAdult(!adult)}
          style={{ flexDirection: 'row', gap: 10, paddingVertical: 12 }}
        >
          <Icon name={adult ? 'check-circle' : 'circle'} size={22} />
          <Text style={{ flex: 1, color: c.ink, lineHeight: 22 }}>
            私は18歳以上です（自己申告）。
          </Text>
        </Pressable>
        {native && Platform.OS === 'ios' && policy?.providers.apple ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={16}
            style={{ height: 54, width: '100%', opacity: busy ? 0.5 : 1 }}
            onPress={() => {
              if (!busy) void login('apple');
            }}
          />
        ) : (
          <Button disabled icon="user" onPress={() => {}}>
            Appleでログイン
          </Button>
        )}
        <Button
          disabled={!native || !policy?.providers.google || busy || !agreed || !adult}
          onPress={() => void login('google')}
        >
          Googleでログイン
        </Button>
      </View>
      {busy && <Text style={s.status}>ログインを確認しています…</Text>}
      {!!error && (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      )}
      <View style={s.note}>
        <Icon name="info" size={16} />
        <Text style={s.noteText}>
          {connectionError
            ? connectionError
            : !native
              ? 'ログインと撮影はiPhone・Androidの専用アプリでご利用ください。'
              : !configured
                ? '新しいアプリのログイン設定を準備しています。設定が完了すると、ここからログインできます。'
                : '写真ライブラリや連絡先へのアクセスは不要です。'}
        </Text>
      </View>
      {(!policy || !configured) && (
        <Button secondary icon="refresh-cw" onPress={() => void reload()}>
          接続状態を確認
        </Button>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  root: { gap: 16, paddingVertical: 16 },
  mark: {
    width: 72,
    height: 72,
    backgroundColor: c.lime,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  eyebrow: { fontSize: 9, letterSpacing: 1.8, color: c.muted },
  title: { fontSize: 29, lineHeight: 42, fontWeight: '700', color: c.ink },
  copy: { fontSize: 14, lineHeight: 25, color: c.muted },
  features: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  featureText: { fontSize: 13, color: c.ink },
  actions: { gap: 12, marginTop: 16 },
  status: { fontSize: 13, color: c.ink },
  error: { color: '#A63832', lineHeight: 22 },
  note: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#EDF1E8',
    padding: 16,
    borderRadius: 16,
  },
  noteText: { flex: 1, color: c.muted, fontSize: 12, lineHeight: 21 },
});
