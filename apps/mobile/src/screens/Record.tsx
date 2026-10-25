import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors as c } from '../theme';
import type { DemoPost } from '../data/demo';
import { Icon, Photo } from '../components/UI';
export function CaptureRecord({ post }: { post: DemoPost }) {
  return (
    <ScrollView contentContainerStyle={s.content}>
      <Photo source={post.photo} style={s.photo} accessibilityLabel={post.description} />
      <View style={s.label}>
        <Icon name="shield" size={18} />
        <Text style={s.labelText}>撮影記録のサンプル</Text>
      </View>
      <Text style={s.copy}>
        これは撮影記録画面の表示例です。実際の撮影を検証した記録ではありません。
      </Text>
      <View style={s.rows}>
        <Row label="撮影方法（表示例）" value="JustTakenのカメラ" />
        <Row label="撮影日時（端末の記録・例）" value="2026.10.25 14:32" />
        <Row label="確認日時（表示例）" value="2026.10.25 14:33" />
        <Row label="現在の状態" value="サンプル・未検証" />
      </View>
      <View style={s.info}>
        <Icon name="info" size={18} />
        <View style={{ flex: 1 }}>
          <Text style={s.infoTitle}>撮影記録で、わかること。</Text>
          <Text style={s.copy}>
            本番では、アプリ内の撮影記録と保存ファイルの一致を確認します。原本は再圧縮せず保持し、表示用プレビューを別に用意します。
          </Text>
        </View>
      </View>
      <Text style={s.disclaimer}>
        写っている内容の真偽、撮影同意、権利関係を保証するものではありません。画面や印刷物を撮り直した写真も含まれ得ます。
      </Text>
    </ScrollView>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}
const s = StyleSheet.create({
  content: { padding: 22, gap: 20, paddingBottom: 45 },
  photo: { width: '100%', height: undefined, aspectRatio: 1.12, borderRadius: 17 },
  label: {
    backgroundColor: c.pale,
    padding: 13,
    borderRadius: 9,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  labelText: { color: c.ink, fontSize: 14, fontWeight: '600' },
  copy: { color: c.ink, fontSize: 13, lineHeight: 23 },
  rows: { borderTopWidth: 1, borderColor: c.line },
  row: { gap: 6, paddingVertical: 18, borderBottomWidth: 1, borderColor: c.line },
  rowLabel: { color: c.muted, fontSize: 11 },
  rowValue: { color: c.ink, fontSize: 13 },
  info: { backgroundColor: c.stone, padding: 17, borderRadius: 15, flexDirection: 'row', gap: 12 },
  infoTitle: { fontSize: 13, fontWeight: '700', color: c.ink, marginBottom: 8 },
  disclaimer: { color: c.muted, fontSize: 12, lineHeight: 22 },
});
