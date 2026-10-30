import { useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { useAuth } from '../services/auth';
import { api } from '../services/api';
import { Button } from './UI';
import { LegalLinks } from './LegalLinks';
import { colors as c } from '../theme';
export function CommunityConsent() {
  const { policy, reload } = useAuth();
  const [agree, setAgree] = useState(false),
    [adult, setAdult] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 20 }}>
      <Text style={{ fontSize: 24, fontWeight: '700', color: c.ink }}>ご利用条件の確認</Text>
      <Text style={{ lineHeight: 24, color: c.ink }}>
        JustTakenは18歳以上の方が利用できます。撮影・投稿の前に最新の利用規約とプライバシーポリシーを確認してください。
      </Text>
      <LegalLinks />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: agree }}
        onPress={() => setAgree(!agree)}
        style={{ padding: 16, backgroundColor: agree ? c.lime : '#EDF1E8', borderRadius: 12 }}
      >
        <Text>利用規約・プライバシーポリシーに同意します</Text>
      </Pressable>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: adult }}
        onPress={() => setAdult(!adult)}
        style={{ padding: 16, backgroundColor: adult ? c.lime : '#EDF1E8', borderRadius: 12 }}
      >
        <Text>私は18歳以上です（自己申告）</Text>
      </Pressable>
      <Button
        disabled={busy || !agree || !adult || !policy?.community}
        onPress={() =>
          void (async () => {
            setBusy(true);
            setError('');
            try {
              await api('/v1/me/consent', {
                termsVersion: policy!.community.termsVersion,
                privacyVersion: policy!.community.privacyVersion,
                ageConfirmed18Plus: true,
              });
              await reload();
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存できませんでした。');
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        同意して続ける
      </Button>
      <Text style={{ lineHeight: 22, color: c.muted }}>
        同意しない場合も、マイページの設定からログアウト・アカウント削除を行えます。
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.red }}>
          {error}
        </Text>
      )}
    </ScrollView>
  );
}
