import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors as c } from '../theme';

const links = [
  { label: '利用規約', url: 'https://justtaken.app/terms' },
  { label: 'プライバシーポリシー', url: 'https://justtaken.app/privacy' },
  { label: 'お問い合わせ', url: 'https://imakai.co.jp/contact' },
];

export function LegalLinks() {
  const [error, setError] = useState('');
  async function open(url: string) {
    setError('');
    try {
      await Linking.openURL(url);
    } catch {
      setError('ページを開けませんでした。通信状態を確認して、もう一度お試しください。');
    }
  }
  return (
    <View style={s.root}>
      <View style={s.links}>
        {links.map(({ label, url }) => (
          <Pressable
            key={url}
            accessibilityRole="link"
            accessibilityLabel={`${label}（ブラウザで開きます）`}
            onPress={() => void open(url)}
            style={s.link}
          >
            <Text style={s.label}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  root: { gap: 8 },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 16 },
  link: { minHeight: 44, justifyContent: 'center' },
  label: { color: c.ink, fontSize: 12, textDecorationLine: 'underline' },
  error: { color: '#A63832', fontSize: 12, lineHeight: 20 },
});
